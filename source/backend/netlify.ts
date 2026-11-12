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
type SiteRecord = {
  id?: string;
  projectId: string;
  siteId: string;
  siteName: string;
  url: string;
  createdAt: number;
};
type DeploymentRecord = {
  id?: string;
  projectId: string;
  actorId: string;
  siteId: string;
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
    /(^|\/)(\.git|\.netlify|node_modules|build|coverage|\.next|\.turbo)(\/|$)/i.test(
      path
    ) ||
    /^\.env(?!\.example$)/i.test(name) ||
    /(^|\/)(id_rsa|id_ed25519|credentials\.json|service-account\.json)$/i.test(
      path
    ) ||
    /\.(pem|key|p12|pfx)$/i.test(name)
  );
}

function safeSiteName(value: string, projectId: string) {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'workspace';
  return ('nova-' + base + '-' + projectId.slice(-6).toLowerCase()).slice(
    0,
    50
  );
}

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  return value.startsWith('http') ? value : 'https://' + value;
}

async function netlifyRequest(
  token: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>,
  rawBody?: Uint8Array
) {
  const response = await fetch('https://api.netlify.com/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(rawBody ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(rawBody ? { body: rawBody } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : typeof data?.error === 'string'
          ? data.error
          : 'Netlify request failed';
    const failure = new Error(
      'Netlify returned HTTP ' + response.status + ': ' + message
    ) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return data;
}

async function sha1(bytes: Uint8Array) {
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

async function updateDeployment(
  record: DeploymentRecord,
  patch: Partial<DeploymentRecord>
) {
  if (!record.id) return null;
  const [updated] = await db.tx.update(
    'netlify_deployments',
    [{ id: record.id, record: patch }],
    { patch: true }
  );
  return updated;
}

export const netlifyRoutes = {
  'POST /api/projects/:id/netlify/deploy': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can create Netlify deployments.',
          403
        );
      }
      const configuredNames = await secrets.listSecretNames();
      if (!configuredNames.includes('NOVA_NETLIFY_TOKEN')) {
        return error(
          'Netlify is not configured. Ask the project owner to connect a Netlify token.',
          503
        );
      }

      try {
        const token = await secrets.readSecret('NOVA_NETLIFY_TOKEN');
        const [folderResult, fileResult, siteResult] = await Promise.all([
          db.list<Folder>('project_folders', { limit: 500 }),
          db.list<ProjectFile>('project_files', { limit: 500 }),
          db.list<SiteRecord>('netlify_sites', { limit: 500 }),
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
        const workspaceFiles = new Map<string, Uint8Array>();
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
          if (shouldSkip(path) || typeof file.content !== 'string') {
            skippedFiles++;
            continue;
          }
          const bytes = new TextEncoder().encode(file.content);
          if (bytes.length > 1024 * 1024)
            return error(
              'File ' +
                path +
                ' exceeds the 1 MB per-file Netlify upload limit.',
              413
            );
          totalBytes += bytes.length;
          if (totalBytes > 20 * 1024 * 1024)
            return error(
              'This project exceeds NOVA’s 20 MB Netlify upload limit. Remove large files and retry.',
              413
            );
          workspaceFiles.set(path, bytes);
        }

        if (!workspaceFiles.size)
          return error(
            'There are no publishable files in this workspace.',
            400
          );
        if (workspaceFiles.size > 300)
          return error(
            'This project contains more than 300 publishable files. Exclude generated files and retry.',
            413
          );

        const packageBytes = workspaceFiles.get('package.json');
        let framework = 'static';
        let publishFiles = new Map<string, Uint8Array>();
        if (packageBytes) {
          let manifest: any;
          try {
            manifest = JSON.parse(new TextDecoder().decode(packageBytes));
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
          const isVite = Boolean(
            dependencies.vite ||
            workspaceFiles.has('vite.config.ts') ||
            workspaceFiles.has('vite.config.js') ||
            workspaceFiles.has('vite.config.mjs')
          );
          if (isVite) {
            if (
              !manifest.scripts?.build ||
              typeof manifest.scripts.build !== 'string'
            ) {
              return error(
                'This Vite project has no build script. Add a production build script before deploying.',
                400
              );
            }
            for (const [path, bytes] of workspaceFiles.entries()) {
              if (path.startsWith('dist/'))
                publishFiles.set(path.slice(5), bytes);
            }
            if (!publishFiles.has('index.html')) {
              return error(
                'Vite source is not built yet. Run npm run build and import or sync the generated dist folder into this NOVA workspace, then retry.',
                400
              );
            }
            framework = 'vite-dist';
          } else {
            if (!workspaceFiles.has('index.html'))
              return error(
                'Netlify direct deploy supports static HTML or a Vite project with a production dist folder. This project needs a build workflow first.',
                400
              );
            for (const [path, bytes] of workspaceFiles.entries()) {
              if (!path.startsWith('dist/') && path !== 'package.json')
                publishFiles.set(path, bytes);
            }
          }
        } else {
          if (!workspaceFiles.has('index.html'))
            return error(
              'Add a root index.html for a static Netlify deployment.',
              400
            );
          for (const [path, bytes] of workspaceFiles.entries()) {
            if (!path.startsWith('dist/')) publishFiles.set(path, bytes);
          }
        }

        if (!publishFiles.has('index.html'))
          return error(
            'The publish folder must contain a root index.html file.',
            400
          );
        if (!publishFiles.size || publishFiles.size > 300)
          return error(
            'The publish folder must contain between 1 and 300 files.',
            400
          );

        const projectName = safeSiteName(access.project.name, params.id);
        let site = siteResult.items.find(item => item.projectId === params.id);
        if (!site) {
          const createdSite = await netlifyRequest(token, '/sites', 'POST', {
            name: projectName,
          });
          const siteId = String(createdSite.id || '');
          if (!siteId)
            return error(
              'Netlify created a site but did not return a site ID. Check Netlify before retrying.',
              502
            );
          const siteRecord: SiteRecord = {
            projectId: params.id,
            siteId,
            siteName: String(createdSite.name || projectName),
            url: normalizeUrl(createdSite.ssl_url || createdSite.url),
            createdAt: Date.now(),
          };
          const [siteRecordId] = await db.add('netlify_sites', [siteRecord]);
          site = { ...siteRecord, id: siteRecordId || undefined };
        }

        const digests: Record<string, string> = {};
        const filesByDigest = new Map<
          string,
          { path: string; bytes: Uint8Array }
        >();
        for (const [path, bytes] of publishFiles.entries()) {
          const digest = await sha1(bytes);
          const netlifyPath = '/' + path;
          digests[netlifyPath] = digest;
          filesByDigest.set(digest, { path, bytes });
        }

        const created = await netlifyRequest(
          token,
          '/sites/' + encodeURIComponent(site.siteId) + '/deploys',
          'POST',
          {
            files: digests,
            draft: true,
          }
        );
        const deploymentId = String(created.id || '');
        if (!deploymentId)
          return error(
            'Netlify accepted the request but did not return a deployment ID. Check Netlify Deploys before retrying.',
            502
          );

        const record: DeploymentRecord = {
          projectId: params.id,
          actorId: user!.userId,
          siteId: site.siteId,
          deploymentId,
          projectName,
          url:
            normalizeUrl(
              created.deploy_ssl_url || created.deploy_url || created.url
            ) || site.url,
          status: String(created.state || 'uploading'),
          framework,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const [recordId] = await db.add('netlify_deployments', [record]);
        record.id = recordId || undefined;

        try {
          const required = Array.isArray(created.required)
            ? (created.required as string[])
            : [];
          for (const digest of required) {
            const item = filesByDigest.get(digest);
            if (!item)
              throw new Error(
                'Netlify requested an unknown file digest. Deployment upload was stopped.'
              );
            const encodedPath = item.path
              .split('/')
              .map(encodeURIComponent)
              .join('/');
            await netlifyRequest(
              token,
              '/deploys/' +
                encodeURIComponent(deploymentId) +
                '/files/' +
                encodedPath,
              'PUT',
              undefined,
              item.bytes
            );
          }
          const latest = await netlifyRequest(
            token,
            '/deploys/' + encodeURIComponent(deploymentId)
          );
          const status = String(latest.state || 'uploading');
          const url =
            normalizeUrl(
              latest.deploy_ssl_url || latest.deploy_url || latest.url
            ) || record.url;
          const errorMessage = String(
            latest.error_message || latest.error?.message || ''
          ).slice(0, 240);
          await updateDeployment(record, {
            status,
            url,
            errorMessage: errorMessage || undefined,
            updatedAt: Date.now(),
          });
          return json(
            {
              deployment: deploymentView({
                ...record,
                status,
                url,
                errorMessage: errorMessage || undefined,
                updatedAt: Date.now(),
              }),
              historySaved: Boolean(record.id),
              siteUrl: site.url,
              skippedFiles,
            },
            201
          );
        } catch (uploadError: any) {
          const message = String(
            uploadError?.message || 'Netlify file upload failed.'
          ).slice(0, 240);
          await updateDeployment(record, {
            status: 'error',
            errorMessage: message,
            updatedAt: Date.now(),
          });
          throw uploadError;
        }
      } catch (err: any) {
        const status = Number(err?.status) || 0;
        const message = String(err?.message || 'Netlify deployment failed.');
        console.error(
          'Netlify draft deployment failed:',
          status,
          message.slice(0, 180)
        );
        if (status === 401)
          return error(
            'Netlify rejected the connected token. Reconnect a valid Netlify access token.',
            401
          );
        if (status === 403)
          return error(
            'Netlify denied access. Check the connected account and team permissions.',
            403
          );
        if (status === 404)
          return error(
            'Netlify could not find the site or deployment in the connected account.',
            404
          );
        if (status === 429)
          return error(
            'Netlify rate limit reached. Wait a little before trying again.',
            429
          );
        return error(message.slice(0, 240), status >= 400 ? status : 502);
      }
    },
  ],

  'GET /api/projects/:id/netlify/deployments': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      const { items } = await db.list<DeploymentRecord>('netlify_deployments', {
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

  'POST /api/projects/:id/netlify/deployments/:deploymentId/refresh': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      const { items } = await db.list<DeploymentRecord>('netlify_deployments', {
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
      if (!configuredNames.includes('NOVA_NETLIFY_TOKEN'))
        return error(
          'Netlify is not configured. Reconnect the provider token to refresh deployment status.',
          503
        );
      try {
        const token = await secrets.readSecret('NOVA_NETLIFY_TOKEN');
        const latest = await netlifyRequest(
          token,
          '/deploys/' + encodeURIComponent(saved.deploymentId)
        );
        const status = String(latest.state || saved.status);
        const url =
          normalizeUrl(
            latest.deploy_ssl_url || latest.deploy_url || latest.url
          ) || saved.url;
        const errorMessage = String(
          latest.error_message || latest.error?.message || ''
        ).slice(0, 240);
        const updatedAt = Date.now();
        await updateDeployment(saved, {
          status,
          url,
          errorMessage: errorMessage || undefined,
          updatedAt,
        });
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
          'Netlify deployment status refresh failed:',
          status,
          String(err?.message || '').slice(0, 160)
        );
        if (status === 401)
          return error(
            'Netlify rejected the connected token. Reconnect the provider token.',
            401
          );
        if (status === 403)
          return error('Netlify denied access to this deployment.', 403);
        if (status === 404)
          return error(
            'Netlify deployment was not found in the connected account.',
            404
          );
        return error(
          'Could not refresh Netlify deployment status. Please retry.',
          status >= 400 ? status : 502
        );
      }
    },
  ],
};
