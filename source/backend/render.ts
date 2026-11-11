import { db, json, error, secrets } from '@appdeploy/sdk';
import { requireSession } from './auth';

type Project = { id?: string; ownerId: string; name: string };
type Member = { projectId: string; userId: string; role: string };
type RenderServiceRecord = {
  projectId: string;
  serviceId: string;
  serviceName: string;
  ownerId: string;
  ownerName: string;
  repo: string;
  branch: string;
  buildCommand: string;
  publishPath: string;
  url: string;
  dashboardUrl: string;
  createdAt: number;
};

async function renderRequest(
  token: string,
  path: string,
  method = 'GET',
  body?: Record<string, unknown>
) {
  const response = await fetch('https://api.render.com/v1' + path, {
    method,
    signal: AbortSignal.timeout(45000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail =
      typeof data?.message === 'string'
        ? data.message
        : typeof data?.error === 'string'
          ? data.error
          : 'Render request failed';
    const failure = new Error(
      'Render returned HTTP ' + response.status + ': ' + detail
    ) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return data;
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

async function readRenderToken() {
  const names = await secrets.listSecretNames();
  if (!names.includes('NOVA_RENDER_API_KEY')) {
    throw new Error(
      'Render is not configured. Connect a Render API key in Deployment Center first.'
    );
  }
  return secrets.readSecret('NOVA_RENDER_API_KEY');
}

async function readSavedService(projectId: string) {
  const [record] = await db.get<RenderServiceRecord>('render_services', [
    projectId,
  ]);
  return record || null;
}

function serviceView(record: RenderServiceRecord) {
  return {
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    ownerName: record.ownerName,
    repo: record.repo,
    branch: record.branch,
    buildCommand: record.buildCommand,
    publishPath: record.publishPath,
    url: record.url,
    dashboardUrl: record.dashboardUrl,
    createdAt: record.createdAt,
  };
}

function deploymentView(item: any) {
  const deploy = item?.deploy || item || {};
  return {
    deploymentId: String(deploy.id || ''),
    status: String(deploy.status || 'unknown'),
    trigger: String(deploy.trigger || ''),
    commitMessage: String(deploy.commit?.message || ''),
    commitId: String(deploy.commit?.id || ''),
    createdAt: deploy.createdAt
      ? new Date(deploy.createdAt).getTime()
      : Date.now(),
    updatedAt: deploy.updatedAt
      ? new Date(deploy.updatedAt).getTime()
      : Date.now(),
  };
}

async function listDeployments(token: string, serviceId: string) {
  const response = await renderRequest(
    token,
    '/services/' + encodeURIComponent(serviceId) + '/deploys?limit=10'
  );
  return Array.isArray(response) ? response.map(deploymentView) : [];
}

function handleRenderError(err: any, action: string) {
  const status = Number(err?.status) || 0;
  const detail = String(err?.message || 'Render request failed.').slice(0, 220);
  console.error('Render ' + action + ' failed:', status, detail);
  if (status === 401)
    return error(
      'Render rejected the connected API key. Reconnect a valid Render API key.',
      401
    );
  if (status === 402)
    return error(
      'Render requires billing information or an eligible plan before creating this service.',
      402
    );
  if (status === 403)
    return error(
      'Render denied this action. Check API key scopes, workspace permissions and GitHub repository access.',
      403
    );
  if (status === 404)
    return error(
      'Render could not find the requested workspace, service or deployment.',
      404
    );
  if (status === 429)
    return error(
      'Render API rate limit reached. Wait a little before trying again.',
      429
    );
  return error(detail, status >= 400 ? status : 502);
}

export const renderRoutes = {
  'GET /api/projects/:id/render/workspaces': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can manage Render deployments.',
          403
        );
      }
      try {
        const token = await readRenderToken();
        const response = await renderRequest(token, '/owners?limit=100');
        const workspaces = (Array.isArray(response) ? response : [])
          .map((item: any) => item.owner || item)
          .filter((owner: any) => owner?.id)
          .map((owner: any) => ({
            id: String(owner.id),
            name: String(owner.name || owner.email || owner.id),
            email: String(owner.email || ''),
            type: String(owner.type || ''),
          }));
        return json({ workspaces });
      } catch (err: any) {
        return handleRenderError(err, 'workspace lookup');
      }
    },
  ],

  'GET /api/projects/:id/render/service': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      const saved = await readSavedService(params.id);
      if (!saved) return json({ service: null, deployments: [] });
      try {
        const token = await readRenderToken();
        const deployments = await listDeployments(token, saved.serviceId);
        return json({ service: serviceView(saved), deployments });
      } catch (err: any) {
        return handleRenderError(err, 'deployment history');
      }
    },
  ],

  'POST /api/projects/:id/render/available-services': [
    requireSession,
    async ({ params, body, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error('Only the project owner can browse Render services.', 403);
      }
      const ownerId = String((body || {}).ownerId || '').trim();
      if (!ownerId) return error('Choose a Render workspace first.', 400);

      try {
        const token = await readRenderToken();
        const ownerResponse = await renderRequest(token, '/owners?limit=100');
        const owners = (Array.isArray(ownerResponse) ? ownerResponse : []).map(
          (item: any) => item.owner || item
        );
        const workspace = owners.find(
          (owner: any) => String(owner.id) === ownerId
        );
        if (!workspace) {
          return error(
            'The selected Render workspace is not available to this API key. Refresh workspaces and try again.',
            403
          );
        }

        const { items: savedRecords } = await db.list<RenderServiceRecord>(
          'render_services',
          { limit: 500 }
        );
        const connectedElsewhere = new Set(
          savedRecords
            .filter(record => record.projectId !== params.id)
            .map(record => record.serviceId)
        );
        const services: any[] = [];
        let cursor = '';
        for (let page = 0; page < 5; page += 1) {
          const query =
            '/services?ownerId=' +
            encodeURIComponent(ownerId) +
            '&type=static_site&limit=100&includePreviews=false' +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
          const response = await renderRequest(token, query);
          const entries = Array.isArray(response) ? response : [];
          for (const entry of entries) {
            const service = entry?.service || entry;
            const serviceId = String(service?.id || '');
            if (
              !serviceId ||
              service.type !== 'static_site' ||
              String(service.ownerId || '') !== ownerId ||
              connectedElsewhere.has(serviceId)
            )
              continue;
            const details = service.serviceDetails || {};
            services.push({
              serviceId,
              serviceName: String(service.name || 'Render Static Site'),
              ownerId,
              ownerName: String(
                workspace.name || workspace.email || 'Render workspace'
              ),
              repo: String(service.repo || ''),
              branch: String(service.branch || ''),
              buildCommand: String(details.buildCommand || ''),
              publishPath: String(details.publishPath || ''),
              url: String(details.url || service.url || ''),
              dashboardUrl: String(service.dashboardUrl || ''),
              createdAt: service.createdAt
                ? new Date(service.createdAt).getTime()
                : Date.now(),
            });
          }
          const nextCursor = entries.length
            ? String(entries[entries.length - 1]?.cursor || '')
            : '';
          if (!nextCursor || entries.length < 100) break;
          cursor = nextCursor;
        }
        return json({ services });
      } catch (err: any) {
        return handleRenderError(err, 'existing service lookup');
      }
    },
  ],

  'POST /api/projects/:id/render/connect': [
    requireSession,
    async ({ params, body, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can connect Render services.',
          403
        );
      }
      const serviceId = String((body || {}).serviceId || '').trim();
      if (!serviceId || serviceId.length > 160)
        return error('Choose a valid existing Render service.', 400);
      const existing = await readSavedService(params.id);
      if (existing)
        return error(
          'A Render service is already connected to this project. Reset its NOVA connection before switching services.',
          409
        );

      try {
        const token = await readRenderToken();
        const fetched = await renderRequest(
          token,
          '/services/' + encodeURIComponent(serviceId)
        );
        const service = fetched.service || fetched;
        if (String(service.id || '') !== serviceId) {
          return error(
            'Render did not return the requested service. Refresh the list and try again.',
            404
          );
        }
        if (service.type !== 'static_site') {
          return error(
            'Only Render Static Sites can be connected to this deployment workflow.',
            400
          );
        }

        const ownerResponse = await renderRequest(token, '/owners?limit=100');
        const owners = (Array.isArray(ownerResponse) ? ownerResponse : []).map(
          (item: any) => item.owner || item
        );
        const ownerId = String(service.ownerId || '');
        const workspace = owners.find(
          (owner: any) => String(owner.id) === ownerId
        );
        if (!workspace) {
          return error(
            'This service does not belong to a Render workspace accessible by the connected API key.',
            403
          );
        }

        const { items: savedRecords } = await db.list<RenderServiceRecord>(
          'render_services',
          { limit: 500 }
        );
        const linked = savedRecords.find(
          record =>
            record.serviceId === serviceId && record.projectId !== params.id
        );
        if (linked) {
          return error(
            'This Render service is already connected to another NOVA IDE project. Each project needs its own Render service.',
            409
          );
        }

        const details = service.serviceDetails || {};
        const record: RenderServiceRecord = {
          projectId: params.id,
          serviceId,
          serviceName: String(service.name || 'Render Static Site'),
          ownerId,
          ownerName: String(
            workspace.name || workspace.email || 'Render workspace'
          ),
          repo: String(service.repo || ''),
          branch: String(service.branch || ''),
          buildCommand: String(details.buildCommand || ''),
          publishPath: String(details.publishPath || ''),
          url: String(details.url || service.url || ''),
          dashboardUrl: String(service.dashboardUrl || ''),
          createdAt: service.createdAt
            ? new Date(service.createdAt).getTime()
            : Date.now(),
        };
        const [savedId] = await db.tx.add('render_services', [
          { id: params.id, ...record },
        ]);
        if (!savedId) {
          const [reconciled] = await db.get<RenderServiceRecord>(
            'render_services',
            [params.id],
            { consistent: true }
          );
          if (!reconciled || reconciled.serviceId !== serviceId) {
            return error(
              'Render service was found, but NOVA could not save its project connection. Refresh before trying again.',
              500
            );
          }
        }
        const saved = await readSavedService(params.id);
        if (!saved)
          return error(
            'Could not confirm the saved Render connection. Refresh and try again.',
            500
          );
        return json(
          {
            service: serviceView(saved),
            deployments: await listDeployments(token, serviceId),
            connected: true,
          },
          200
        );
      } catch (err: any) {
        return handleRenderError(err, 'connect existing service');
      }
    },
  ],

  'DELETE /api/projects/:id/render/service': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can reset the Render connection.',
          403
        );
      }
      const saved = await readSavedService(params.id);
      if (!saved)
        return error('No Render service is connected to this project.', 404);
      const [deleted] = await db.delete('render_services', [params.id]);
      if (!deleted)
        return error(
          'Could not reset the saved Render connection. Refresh and try again.',
          500
        );
      return json({
        reset: true,
        serviceDeleted: false,
        message:
          'The Render service link was removed from NOVA IDE. The actual Render service and live site were not deleted.',
      });
    },
  ],

  'POST /api/projects/:id/render/services': [
    requireSession,
    async ({ params, body, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error('Only the project owner can create Render services.', 403);
      }
      const input = (body || {}) as {
        repo?: string;
        branch?: string;
        ownerId?: string;
        buildCommand?: string;
        publishPath?: string;
      };
      const repo = String(input.repo || '').trim();
      const branch = String(input.branch || 'main').trim();
      const ownerId = String(input.ownerId || '').trim();
      const buildCommand = String(input.buildCommand || '').trim();
      const publishPath = String(input.publishPath || '').trim();
      if (
        !/^https:\/\/(github\.com|gitlab\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
          repo
        )
      ) {
        return error(
          'Enter a valid public or Render-connected GitHub/GitLab repository URL.',
          400
        );
      }
      if (!ownerId) return error('Choose a Render workspace.', 400);
      if (!branch || branch.length > 120 || /[\s?#]/.test(branch)) {
        return error('Enter a valid Git branch name.', 400);
      }
      if (!buildCommand || buildCommand.length > 500) {
        return error('Enter a build command (maximum 500 characters).', 400);
      }
      if (
        !publishPath ||
        publishPath.length > 160 ||
        publishPath.startsWith('/') ||
        publishPath.split('/').some(part => part === '..') ||
        !/^[A-Za-z0-9._/-]+$/.test(publishPath)
      ) {
        return error(
          'Enter a valid publish directory such as dist, build or .',
          400
        );
      }

      const existing = await readSavedService(params.id);
      if (existing)
        return error(
          'A Render service is already connected to this project. Use its Manual deploy button instead.',
          409
        );

      try {
        const token = await readRenderToken();
        const ownerResponse = await renderRequest(token, '/owners?limit=100');
        const owners = (Array.isArray(ownerResponse) ? ownerResponse : []).map(
          (item: any) => item.owner || item
        );
        const workspace = owners.find(
          (owner: any) => String(owner.id) === ownerId
        );
        if (!workspace)
          return error(
            'The selected Render workspace is not available to this API key. Refresh workspaces and try again.',
            403
          );

        const baseName =
          access.project.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 30) || 'project';
        const serviceName = (
          'nova-' +
          baseName +
          '-' +
          params.id.slice(-6).toLowerCase()
        ).slice(0, 50);
        const created = await renderRequest(token, '/services', 'POST', {
          type: 'static_site',
          name: serviceName,
          ownerId,
          repo,
          branch,
          autoDeployTrigger: 'off',
          serviceDetails: {
            buildCommand,
            publishPath,
          },
        });
        const service = created.service || created;
        const serviceId = String(service.id || '');
        if (!serviceId)
          return error(
            'Render accepted the request but did not return a service ID. Check the Render dashboard before retrying.',
            502
          );
        const record: RenderServiceRecord = {
          projectId: params.id,
          serviceId,
          serviceName: String(service.name || serviceName),
          ownerId,
          ownerName: String(
            workspace.name || workspace.email || 'Render workspace'
          ),
          repo,
          branch,
          buildCommand,
          publishPath,
          url: String(service.serviceDetails?.url || service.url || ''),
          dashboardUrl: String(service.dashboardUrl || ''),
          createdAt: Date.now(),
        };
        const [savedId] = await db.tx.add('render_services', [
          {
            id: params.id,
            ...record,
          },
        ]);
        if (!savedId) {
          const [reconciled] = await db.get<RenderServiceRecord>(
            'render_services',
            [params.id],
            { consistent: true }
          );
          if (!reconciled) {
            return error(
              'Render created the service, but NOVA could not save its project link. Check Render before creating another service.',
              500
            );
          }
          return json(
            {
              service: serviceView(reconciled),
              initialDeploymentId: String(created.deployId || ''),
              deployments: await listDeployments(token, reconciled.serviceId),
            },
            201
          );
        }
        const savedRecord = { ...record };
        return json(
          {
            service: serviceView(savedRecord),
            initialDeploymentId: String(created.deployId || ''),
            deployments: await listDeployments(token, serviceId),
          },
          201
        );
      } catch (err: any) {
        return handleRenderError(err, 'service creation');
      }
    },
  ],

  'POST /api/projects/:id/render/services/:serviceId/deploy': [
    requireSession,
    async ({ params, user }: any) => {
      const access = await projectAccess(params.id, user!.userId);
      if (!access) return error('Project not found or access denied.', 404);
      if (
        access.project.ownerId !== user!.userId ||
        access.membership.role !== 'owner'
      ) {
        return error(
          'Only the project owner can trigger Render deployments.',
          403
        );
      }
      const saved = await readSavedService(params.id);
      if (!saved || saved.serviceId !== params.serviceId) {
        return error('Render service not found for this project.', 404);
      }
      try {
        const token = await readRenderToken();
        const deployment = await renderRequest(
          token,
          '/services/' + encodeURIComponent(saved.serviceId) + '/deploys',
          'POST',
          {}
        );
        return json({ deployment: deploymentView(deployment) }, 201);
      } catch (err: any) {
        return handleRenderError(err, 'manual deploy');
      }
    },
  ],
};
