import { db, json, error, secrets } from '@appdeploy/sdk';
import { requireSession } from './auth';

type Project = { id?: string; ownerId: string; name: string };
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
type DeploymentRecord = {
  id?: string;
  projectId: string;
  actorId: string;
  deploymentId: string;
  projectName: string;
  url: string;
  status: string;
  framework: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

function folderPath(
  id: string | null | undefined,
  foldersById: Map<string, Folder>,
  visited = new Set<string>()
): string {
  if (!id || visited.has(id)) return '';
  const folder = foldersById.get(id);
  if (!folder) return '';
  visited.add(id);
  const parent = folderPath(folder.parentId, foldersById, visited);
  return parent ? parent + '/' + folder.name : folder.name;
}

function shouldSkip(path: string) {
  const name = path.split('/').pop() || path;
  return (
    /(^|\/)(\.git|\.vercel|node_modules|dist|build|coverage|\.next|\.turbo)(\/|$)/i.test(
      path
    ) ||
    /^\.env(?!\.example$)/i.test(name) ||
    /(^|\/)(id_rsa|id_ed25519|credentials\.json|service-account\.json)$/i.test(
      path
    ) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}

function safeProjectName(value: string, projectId: string) {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 38) || 'workspace';
  return ('nova-' + base + '-' + projectId.slice(-6).toLowerCase()).slice(
    0,
    52
  );
}

async function vercelRequest(
  token: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  rawBody?: Uint8Array,
  digest?: string
) {
  const response = await fetch('https://api.vercel.com' + path, {
    method,
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(rawBody
        ? {
            'Content-Type': 'application/octet-stream',
            'x-vercel-digest': digest || '',
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(rawBody ? { body: rawBody } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.error?.message === 'string'
        ? data.error.message
        : typeof data?.message === 'string'
          ? data.message
          : 'Vercel request failed';
    const failure = new Error(
      'Vercel returned HTTP ' + response.status + ': ' + message
    ) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return data;
}

async function fileDigest(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

async function projectAccess(projectId: string, userId: string) {
  const [project] = await db.get<Project>('projects', [projectId]);
  if (!project) return null;
  const { items } = await db.list<Member>('project_members', { limit: 500 });
  const membership = items.find(
    item => item.projectId === projectId && item.userId === userId
  );
  if (!membership) return null;
  return { project: { ...project, id: projectId }, membership };
}

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  return value.startsWith('http') ? value : 'https://' + value;
}

function deploymentView(record: DeploymentRecord) {
  return {
    id: record.id,
    deploymentId: record.deploymentId,
    projectName: record.projectName,
    url: record.url,
    status: record.status,
    framework: record.framework,
    errorMessage: record.errorMessage || '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export const vercelRoutes = {
  'POST /api/projects/:id/vercel/deploy': [
    requireSession,
    async ({ params, body, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can deploy this project to Vercel.',
          403
        );
      }

      const configuredNames = await secrets.listSecretNames();
      if (!configuredNames.includes('NOVA_VERCEL_TOKEN')) {
        return error(
          'Vercel is not configured. Ask the project owner to connect a Vercel token.',
          503
        );
      }

      try {
        const token = await secrets.readSecret('NOVA_VERCEL_TOKEN');
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
        const sourceFiles = new Map<string, string>();
        let skippedFiles = 0;
        let totalBytes = 0;

        for (const file of files) {
          const parentPath = folderPath(file.parentId, foldersById);
          const path = [parentPath, file.name].filter(Boolean).join('/');
          if (
            !path ||
            path.startsWith('/') ||
            path
              .split('/')
              .some(part => !part || part === '.' || part === '..') ||
            /[\\\u0000-\u001f]/.test(path)
          ) {
            skippedFiles++;
            continue;
          }
          if (shouldSkip(path)) {
            skippedFiles++;
            continue;
          }
          if (typeof file.content !== 'string') {
            skippedFiles++;
            continue;
          }
          const bytes = new TextEncoder().encode(file.content);
          if (bytes.length > 1024 * 1024) {
            return error(
              'File ' +
                path +
                ' exceeds the 1 MB per-file Vercel upload limit.',
              413
            );
          }
          totalBytes += bytes.length;
          if (totalBytes > 20 * 1024 * 1024) {
            return error(
              'This project exceeds NOVA’s 20 MB Vercel upload limit. Remove generated or large files and retry.',
              413
            );
          }
          sourceFiles.set(path, file.content);
        }

        if (!sourceFiles.size) {
          return error(
            'There are no publishable source files in this workspace.',
            400
          );
        }
        if (sourceFiles.size > 300) {
          return error(
            'This project contains more than 300 publishable files. Exclude generated files and retry.',
            413
          );
        }

        const packageSource = sourceFiles.get('package.json');
        let framework: 'vite' | null = null;
        let projectSettings: Record<string, unknown> = { framework: null };
        if (packageSource) {
          let manifest: any;
          try {
            manifest = JSON.parse(packageSource);
          } catch {
            return error(
              'The root package.json is not valid JSON. Fix it before deploying.',
              400
            );
          }
          const dependencies = {
            ...(manifest.dependencies || {}),
            ...(manifest.devDependencies || {}),
          };
          const scripts = manifest.scripts || {};
          const hasVite = Boolean(
            dependencies.vite ||
            sourceFiles.has('vite.config.ts') ||
            sourceFiles.has('vite.config.js') ||
            sourceFiles.has('vite.config.mjs')
          );
          if (
            !hasVite ||
            typeof scripts.build !== 'string' ||
            !scripts.build.trim()
          ) {
            return error(
              'NOVA currently supports static HTML projects and Vite projects with a build script on Vercel. This project uses a different build setup.',
              400
            );
          }
          if (!sourceFiles.has('index.html')) {
            return error(
              'A Vite project must include a root index.html file for this deployment workflow.',
              400
            );
          }
          framework = 'vite';
          projectSettings = {
            framework: 'vite',
            buildCommand: 'npm run build',
            installCommand: 'npm install',
            outputDirectory: 'dist',
          };
        } else if (!sourceFiles.has('index.html')) {
          return error(
            'For a static Vercel deployment, add a root index.html. Vite projects must include package.json and a build script.',
            400
          );
        }

        const projectName = safeProjectName(access.project.name, params.id);
        const uploadedFiles: Array<{
          file: string;
          sha: string;
          size: number;
        }> = [];
        for (const [path, content] of sourceFiles.entries()) {
          const bytes = new TextEncoder().encode(content);
          const sha = await fileDigest(bytes);
          await vercelRequest(
            token,
            '/v2/files',
            'POST',
            undefined,
            bytes,
            sha
          );
          uploadedFiles.push({ file: path, sha, size: bytes.length });
        }

        const created = await vercelRequest(token, '/v13/deployments', 'POST', {
          name: projectName,
          files: uploadedFiles,
          projectSettings,
        });
        const deploymentId = String(created.id || created.uid || '');
        if (!deploymentId) {
          return error(
            'Vercel accepted the request but did not return a deployment ID. Check Vercel Deployments before retrying.',
            502
          );
        }
        const record: DeploymentRecord = {
          projectId: params.id,
          actorId: user!.userId,
          deploymentId,
          projectName,
          url: normalizeUrl(created.url),
          status: String(created.readyState || created.state || 'QUEUED'),
          framework: framework || 'static',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const [recordId] = await db.add('vercel_deployments', [record]);
        return json(
          {
            deployment: deploymentView({
              ...record,
              id: recordId || undefined,
            }),
            historySaved: Boolean(recordId),
            skippedFiles,
          },
          201
        );
      } catch (err: any) {
        const status = Number(err?.status) || 0;
        const message = String(err?.message || 'Vercel deployment failed.');
        console.error(
          'Vercel preview deployment failed:',
          status,
          message.slice(0, 180)
        );
        if (status === 401) {
          return error(
            'Vercel rejected the connected token. Reconnect a valid Vercel access token.',
            401
          );
        }
        if (status === 403) {
          return error(
            'Vercel denied access. Check that this token can create deployments in the connected account or team.',
            403
          );
        }
        if (status === 404) {
          return error(
            'Vercel could not find the requested project or upload resource. Check the connected account and project access.',
            404
          );
        }
        if (status === 429) {
          return error(
            'Vercel rate limit reached. Wait a little before trying again.',
            429
          );
        }
        return error(message.slice(0, 240), status >= 400 ? status : 502);
      }
    },
  ],

  'GET /api/projects/:id/vercel/deployments': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      const { items } = await db.list<DeploymentRecord>('vercel_deployments', {
        limit: 500,
      });
      const deployments = items
        .filter(item => item.projectId === params.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10)
        .map(deploymentView);
      return json({ deployments });
    },
  ],

  'POST /api/projects/:id/vercel/deployments/:deploymentId/refresh': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      const { items } = await db.list<DeploymentRecord>('vercel_deployments', {
        limit: 500,
      });
      const saved = items.find(
        item =>
          item.projectId === params.id &&
          item.deploymentId === params.deploymentId
      );
      if (!saved || !saved.id)
        return error('Deployment history entry not found.', 404);
      const configuredNames = await secrets.listSecretNames();
      if (!configuredNames.includes('NOVA_VERCEL_TOKEN')) {
        return error(
          'Vercel is not configured. Reconnect the provider token to refresh deployment status.',
          503
        );
      }
      try {
        const token = await secrets.readSecret('NOVA_VERCEL_TOKEN');
        const latest = await vercelRequest(
          token,
          '/v13/deployments/' + encodeURIComponent(saved.deploymentId)
        );
        const status = String(
          latest.readyState || latest.state || saved.status
        );
        const url = normalizeUrl(latest.url) || saved.url;
        const errorMessage = String(
          latest.errorMessage || latest.error?.message || ''
        ).slice(0, 240);
        const updatedAt = Date.now();
        const [updated] = await db.tx.update(
          'vercel_deployments',
          [
            {
              id: saved.id,
              record: {
                status,
                url,
                errorMessage: errorMessage || undefined,
                updatedAt,
              },
            },
          ],
          { patch: true }
        );
        if (!updated)
          return error('Could not save the refreshed deployment status.', 500);
        return json({
          deployment: deploymentView({
            ...saved,
            status,
            url,
            errorMessage: errorMessage || undefined,
            updatedAt,
          }),
        });
      } catch (err: any) {
        const status = Number(err?.status) || 0;
        console.error(
          'Vercel deployment status refresh failed:',
          status,
          String(err?.message || '').slice(0, 160)
        );
        if (status === 401)
          return error(
            'Vercel rejected the connected token. Reconnect the provider token.',
            401
          );
        if (status === 403)
          return error('Vercel denied access to this deployment.', 403);
        if (status === 404)
          return error(
            'Vercel deployment was not found in the connected account.',
            404
          );
        return error(
          'Could not refresh Vercel deployment status. Please retry.',
          status >= 400 ? status : 502
        );
      }
    },
  ],
};
