import { db, json, error, secrets } from '@appdeploy/sdk';
import { requireSession } from './auth';

type Project = { ownerId: string; name: string };
type Member = { projectId: string; userId: string; role: string };
type Folder = {
  id?: string;
  projectId: string;
  parentId?: string | null;
  name: string;
};
type ProjectFile = {
  id?: string;
  projectId: string;
  parentId?: string | null;
  name: string;
  content: string;
};

function parseRepository(value: unknown) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const match = cleaned.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/i
  );
  if (!match || match[2].includes('..')) return null;
  return { owner: match[1], repo: match[2] };
}

async function githubRequest(
  token: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>
) {
  const response = await fetch('https://api.github.com' + path, {
    method,
    signal: AbortSignal.timeout(45000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NOVA-IDE',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : 'GitHub request failed';
    const failure = new Error(
      'GitHub returned HTTP ' + response.status + ': ' + message
    ) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function folderPath(
  id: string | null | undefined,
  foldersById: Map<string, Folder>,
  visited = new Set<string>()
): string {
  if (!id) return '';
  if (visited.has(id)) return '';
  const folder = foldersById.get(id);
  if (!folder) return '';
  visited.add(id);
  const parent = folderPath(folder.parentId, foldersById, visited);
  return parent ? parent + '/' + folder.name : folder.name;
}

function shouldSkip(path: string) {
  const name = path.split('/').pop() || path;
  if (
    /(^|\/)(\.git|node_modules|dist|build|coverage|\.next)(\/|$)/i.test(path)
  ) {
    return true;
  }
  if (/^\.env(?!\.example$)/i.test(name)) return true;
  if (
    /(^|\/)(id_rsa|id_ed25519|credentials\.json|service-account\.json)$/i.test(
      path
    ) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  ) {
    return true;
  }
  return false;
}

export const githubRoutes = {
  'POST /api/projects/:id/github/push': [
    requireSession,
    async ({ params, body, user }: any) => {
      const [project] = await db.get<Project>('projects', [params.id]);
      if (!project) return error('Project not found or access denied.', 404);
      const { items: memberships } = await db.list<Member>('project_members', {
        limit: 500,
      });
      const membership = memberships.find(
        item => item.projectId === params.id && item.userId === user!.userId
      );
      if (!membership) return error('Project not found or access denied.', 404);
      if (project.ownerId !== user!.userId || membership.role !== 'owner') {
        return error(
          'Only the project owner can publish this project to GitHub.',
          403
        );
      }

      const input = body || {};
      const repository = parseRepository(input.repositoryUrl);
      if (!repository) {
        return error(
          'Enter a valid GitHub repository URL, such as https://github.com/owner/repo.',
          400
        );
      }
      if (
        typeof input.readme !== 'string' ||
        typeof input.gitignore !== 'string' ||
        input.readme.length > 100000 ||
        input.gitignore.length > 30000 ||
        (input.license !== undefined &&
          (typeof input.license !== 'string' || input.license.length > 30000))
      ) {
        return error(
          'Review the project metadata files; one or more fields are invalid or too large.',
          400
        );
      }
      const requestedBranch =
        typeof input.branch === 'string' ? input.branch.trim() : '';
      if (
        requestedBranch &&
        (!/^[A-Za-z0-9._/-]{1,100}$/.test(requestedBranch) ||
          requestedBranch.includes('..') ||
          requestedBranch.startsWith('/') ||
          requestedBranch.endsWith('/'))
      ) {
        return error('Enter a valid branch name.', 400);
      }

      const secretNames = await secrets.listSecretNames();
      if (!secretNames.includes('NOVA_GITHUB_TOKEN')) {
        return error(
          'GitHub is not configured. Ask the project owner to connect a GitHub token.',
          503
        );
      }

      try {
        const token = await secrets.readSecret('NOVA_GITHUB_TOKEN');
        const repoPath = '/repos/' + repository.owner + '/' + repository.repo;
        const repoInfo = await githubRequest(token, repoPath);
        if (repoInfo.permissions?.push === false) {
          return error(
            'The connected GitHub account does not have push access to this repository.',
            403
          );
        }
        const branch = requestedBranch || repoInfo.default_branch || 'main';

        const [folderResult, fileResult] = await Promise.all([
          db.list<Folder>('project_folders', { limit: 500 }),
          db.list<ProjectFile>('project_files', { limit: 500 }),
        ]);
        const folders = folderResult.items.filter(
          item => item.projectId === params.id
        );
        const files = fileResult.items.filter(
          item => item.projectId === params.id
        );
        const foldersById = new Map(
          folders.filter(item => item.id).map(item => [item.id!, item])
        );

        const payloadFiles = new Map<string, string>();
        let skippedFiles = 0;
        let totalBytes = 0;
        for (const file of files) {
          const pathParts = [
            folderPath(file.parentId, foldersById),
            file.name,
          ].filter(Boolean);
          const path = pathParts.join('/');
          if (!path || path.startsWith('/') || path.split('/').includes('..')) {
            skippedFiles++;
            continue;
          }
          if (shouldSkip(path)) {
            skippedFiles++;
            continue;
          }
          const size = new TextEncoder().encode(file.content || '').length;
          if (size > 1024 * 1024) {
            return error(
              'File ' +
                path +
                ' is larger than the 1 MB per-file GitHub publishing limit.',
              413
            );
          }
          totalBytes += size;
          if (totalBytes > 20 * 1024 * 1024) {
            return error(
              'This project exceeds NOVA’s 20 MB GitHub push limit. Exclude generated or large files and try again.',
              413
            );
          }
          payloadFiles.set(path, file.content || '');
        }

        payloadFiles.set('README.md', input.readme);
        payloadFiles.set('.gitignore', input.gitignore);
        if (typeof input.license === 'string' && input.license.trim()) {
          payloadFiles.set('LICENSE', input.license);
        }
        if (payloadFiles.size > 300) {
          return error(
            'This project contains more than 300 publishable files. Exclude generated files and try again.',
            413
          );
        }

        let baseSha = '';
        let baseTreeSha = '';
        try {
          const ref = await githubRequest(
            token,
            repoPath + '/git/ref/heads/' + encodeURIComponent(branch)
          );
          baseSha = ref.object.sha;
          const commit = await githubRequest(
            token,
            repoPath + '/git/commits/' + baseSha
          );
          baseTreeSha = commit.tree.sha;
        } catch (refError: any) {
          if (refError?.status !== 404) throw refError;
          if (requestedBranch) {
            return error(
              'Branch not found. Clear the branch field to use the repository default branch, or create the branch on GitHub first.',
              404
            );
          }
        }

        const tree = Array.from(payloadFiles.entries()).map(
          ([path, content]) => ({
            path,
            mode: '100644',
            type: 'blob',
            content,
          })
        );
        const treeResult = await githubRequest(
          token,
          repoPath + '/git/trees',
          'POST',
          {
            ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
            tree,
          }
        );
        const commitResult = await githubRequest(
          token,
          repoPath + '/git/commits',
          'POST',
          {
            message: 'Publish ' + project.name + ' from NOVA IDE',
            tree: treeResult.sha,
            ...(baseSha ? { parents: [baseSha] } : {}),
          }
        );

        if (baseSha) {
          await githubRequest(
            token,
            repoPath + '/git/refs/heads/' + encodeURIComponent(branch),
            'PATCH',
            { sha: commitResult.sha, force: false }
          );
        } else {
          await githubRequest(token, repoPath + '/git/refs', 'POST', {
            ref: 'refs/heads/' + branch,
            sha: commitResult.sha,
          });
        }

        return json({
          success: true,
          repositoryUrl:
            'https://github.com/' + repository.owner + '/' + repository.repo,
          branch,
          commitSha: commitResult.sha,
          fileCount: payloadFiles.size,
          skippedFiles,
        });
      } catch (err: any) {
        console.error(
          'GitHub project push failed:',
          err?.message || 'Unknown error'
        );
        const message = String(err?.message || 'GitHub publishing failed.');
        if (message.includes('HTTP 401')) {
          return error(
            'GitHub rejected the token. Reconnect a valid token with repository contents write permission.',
            401
          );
        }
        if (message.includes('HTTP 403')) {
          return error(
            'GitHub denied this operation. Check token permissions and repository access.',
            403
          );
        }
        if (message.includes('HTTP 404')) {
          return error(
            'Repository not found or the connected GitHub account cannot access it.',
            404
          );
        }
        if (message.includes('HTTP 409')) {
          return error(
            'The repository changed during the push. Refresh the repository branch and retry.',
            409
          );
        }
        return error(message.slice(0, 240), 502);
      }
    },
  ],
};
