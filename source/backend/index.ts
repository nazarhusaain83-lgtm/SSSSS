import { db, router, json, error } from '@appdeploy/sdk';
import { requireSession, authRoutes } from './auth';
import { listAll } from './data';
import { workspaceRoutes } from './workspace';
import { assistantRoutes } from './assistant';
import { teamRoutes } from './team';
import { deploymentIntegrationRoutes } from './deployment-integrations';
import { githubRoutes } from './github';
import { vercelRoutes } from './vercel';
import { netlifyRoutes } from './netlify';
import { renderRoutes } from './render';
import {
  addSubscription,
  removeSubscriptions,
  notifySubscribers,
} from './realtime-subscribers';

type ProjectRecord = {
  id?: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  createdAt: number;
};

type MemberRecord = {
  id?: string;
  projectId: string;
  userId: string;
  name: string;
  email?: string;
  role: string;
  joinedAt: number;
};

type FileRecord = {
  id?: string;
  projectId: string;
  parentId?: string | null;
  name: string;
  content: string;
  updatedAt: number;
};

async function getMembership(projectId: string, userId: string) {
  const matches = await listAll<MemberRecord>('project_members', { projectId, userId });
  return matches[0] || null;
}

async function requireProjectMember(projectId: string, userId: string) {
  const membership = await getMembership(projectId, userId);
  if (!membership) return null;
  const [project] = await db.get<ProjectRecord>('projects', [projectId]);
  if (!project) return null;
  return { project: { ...project, id: projectId }, membership };
}

function memberView(member: MemberRecord) {
  return {
    id: member.id,
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    joinedAt: member.joinedAt,
  };
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, value => INVITE_ALPHABET[value & 31]).join('');
}

export const handler = router({
  ...authRoutes,
  ...workspaceRoutes,
  ...assistantRoutes,
  ...teamRoutes,
  ...deploymentIntegrationRoutes,
  ...githubRoutes,
  ...vercelRoutes,
  ...netlifyRoutes,
  ...renderRoutes,
  'GET /api/_healthcheck': [
    async () =>
      json({
        message: 'Success',
        buildVersion: 'nova-ide-2026-11-09-import-v1',
      }),
  ],

  'GET /api/projects/:id/deployment-activity': [
    requireSession,
    async ({ params, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const items = await listAll<any>('deployment_activity', { projectId: params.id }, 5000);
      const activity = items
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);
      return json({ activity });
    },
  ],

  'POST /api/projects/:id/deployment-activity': [
    requireSession,
    async ({ params, body, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const input = (body || {}) as {
        status?: string;
        summary?: string;
        stack?: string;
        sourceCodeCount?: number;
        checks?: Array<{ name: string; status: string; detail: string }>;
      };
      if (
        !['blocked', 'review', 'ready_for_build'].includes(
          input.status || ''
        ) ||
        typeof input.summary !== 'string' ||
        !Array.isArray(input.checks) ||
        input.checks.length > 12
      ) {
        return error('Invalid deployment check report.', 400);
      }
      const record = {
        projectId: params.id,
        actorId: user!.userId,
        actorName: user!.name || user!.email || 'Team member',
        status: input.status,
        summary: input.summary.slice(0, 240),
        stack: String(input.stack || 'Unknown').slice(0, 100),
        sourceCodeCount: Math.max(
          0,
          Math.min(100000, Number(input.sourceCodeCount) || 0)
        ),
        checks: input.checks.map(item => ({
          name: String(item.name || '').slice(0, 80),
          status: ['passed', 'warning', 'blocked', 'review'].includes(
            item.status
          )
            ? item.status
            : 'review',
          detail: String(item.detail || '').slice(0, 240),
        })),
        createdAt: Date.now(),
      };
      const [id] = await db.add('deployment_activity', [record]);
      if (!id) return error('Could not save deployment activity.', 500);
      return json({ activity: { id, ...record } }, 201);
    },
  ],

  'GET /api/projects': [
    requireSession,
    async ({ user }) => {
      const memberships = await listAll<MemberRecord>('project_members', { userId: user!.userId });
      const ids = memberships.map(item => item.projectId);
      if (!ids.length) return json({ projects: [] });
      const records = await db.get<ProjectRecord>('projects', ids);
      const projects = records
        .map((project, index) =>
          project ? { ...project, id: ids[index] } : null
        )
        .filter(Boolean);
      return json({ projects });
    },
  ],

  'DELETE /api/projects/:id': [
    requireSession,
    async ({ params, user }) => {
      const [project] = await db.get<ProjectRecord>('projects', [params.id]);
      if (!project) return error('Project not found.', 404);
      const membership = await getMembership(params.id, user!.userId);
      if (
        project.ownerId !== user!.userId ||
        !membership ||
        membership.role !== 'owner'
      ) {
        return error('Only the project owner can delete this workspace.', 403);
      }

      const relatedTables = [
        'project_files',
        'project_folders',
        'project_members',
        'deployment_activity',
        'team_profiles',
        'team_assignments',
        'team_scaffold_runs',
        'team_setup_choices',
        'netlify_sites',
        'netlify_deployments',
        'vercel_deployments',
        'render_services',
        'entity_subscriptions',
      ];

      for (const table of relatedTables) {
        const page = await db.list<{
          projectId?: string;
          entity_type?: string;
          entity_id?: string;
        }>(table, { limit: 500 });
        if (page.nextToken) {
          return error(
            'This workspace has too many related records to delete in one request. Contact support for assistance.',
            409
          );
        }
        const ids = page.items
          .filter(record =>
            table === 'entity_subscriptions'
              ? record.entity_type === 'project' && record.entity_id === params.id
              : record.projectId === params.id
          )
          .map(record => record.id);
        if (!ids.length) continue;
        const results = await db.delete(table, ids);
        if (results.some(result => !result)) {
          return error(
            'Some workspace data could not be deleted. Refresh and retry the project deletion.',
            500
          );
        }
      }

      const [deleted] = await db.delete('projects', [params.id]);
      if (!deleted) {
        return error('Workspace data was removed, but the project record could not be deleted. Please retry.',
          500
        );
      }
      return json({ deleted: true, projectId: params.id });
    },
  ],

  'POST /api/projects': [
    requireSession,
    async ({ body, user }) => {
      const input = (body && typeof body === 'object' ? body : {}) as { name?: unknown };
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 48)
        return error('Project name must be 1–48 characters.', 400);

      const existing = await listAll<ProjectRecord>('projects', undefined, 10000);
      const existingCodes = new Set(existing.map(item => item.inviteCode));
      let code = '';
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = inviteCode();
        if (!existingCodes.has(candidate)) { code = candidate; break; }
      }
      if (!code) return error('Could not generate a unique invite code. Please retry.', 503);

      const [projectId] = await db.add('projects', [
        {
          name,
          ownerId: user!.userId,
          inviteCode: code,
          createdAt: Date.now(),
        },
      ]);
      if (!projectId)
        return error('Could not create the project. Please retry.', 500);

      const [memberId] = await db.add('project_members', [
        {
          projectId,
          userId: user!.userId,
          name: user!.name || user!.email?.split('@')[0] || 'Project owner',
          email: user!.email,
          role: 'owner',
          joinedAt: Date.now(),
        },
      ]);
      if (!memberId) {
        await db.delete('projects', [projectId]);
        return error('Could not add the project owner. Please retry.', 500);
      }

      const starterFiles = [
        {
          name: 'index.html',
          content:
            '<!DOCTYPE html>\n<html>\n  <head>\n    <title>My Project</title>\n  </head>\n  <body>\n    <h1>Hello, Nova IDE!</h1>\n  </body>\n</html>',
        },
        {
          name: 'style.css',
          content: 'body {\n  font-family: sans-serif;\n  margin: 2rem;\n}\n',
        },
        {
          name: 'script.js',
          content: "console.log('Hello from Nova IDE!');\n",
        },
      ];
      const createdAt = Date.now();
      const ids = await db.add(
        'project_files',
        starterFiles.map(file => ({
          projectId,
          ...file,
          updatedAt: createdAt,
        }))
      );
      const files = starterFiles
        .map((file, index) => ({
          id: ids[index],
          projectId,
          ...file,
          updatedAt: createdAt,
        }))
        .filter(file => file.id);
      const project = {
        id: projectId,
        name,
        ownerId: user!.userId,
        inviteCode: code,
        createdAt,
      };
      return json(
        {
          project,
          files,
          members: [
            {
              userId: user!.userId,
              name: user!.name || user!.email?.split('@')[0] || 'Project owner',
              email: user!.email,
              role: 'owner',
            },
          ],
        },
        201
      );
    },
  ],

  'POST /api/projects/join': [
    requireSession,
    async ({ body, user }) => {
      const input = (body && typeof body === 'object' ? body : {}) as { inviteCode?: unknown };
      const code = typeof input.inviteCode === 'string' ? input.inviteCode.trim().toUpperCase() : '';
      if (!/^[A-Z0-9]{6}$/.test(code))
        return error('Enter a valid 6-character invite code.', 400);
      const projects = await listAll<ProjectRecord>('projects', undefined, 10000);
      const match = projects.find(project => project.inviteCode === code);
      if (!match) return error('That invite code was not found.', 404);
      const projectId = match.id!;
      const existing = await getMembership(projectId, user!.userId);
      if (existing) {
        const [project] = await db.get<ProjectRecord>('projects', [projectId]);
        return json({ project: { ...project, id: projectId } });
      }
      const members = await listAll<MemberRecord>('project_members', { projectId });
      if (members.length >= 3)
        return error('This workspace already has all 3 seats filled.', 409);

      const [memberId] = await db.add('project_members', [
        {
          projectId,
          userId: user!.userId,
          name: user!.name || user!.email?.split('@')[0] || 'Teammate',
          email: user!.email,
          role: 'member',
          joinedAt: Date.now(),
        },
      ]);
      if (!memberId)
        return error('Could not join this project. Please retry.', 500);
      const member = {
        id: memberId,
        userId: user!.userId,
        name: user!.name || user!.email?.split('@')[0] || 'Teammate',
        email: user!.email,
        role: 'member',
      };
      await notifySubscribers('project', projectId, {
        action: 'member-joined',
        member,
      });
      return json({ project: { ...match, id: projectId } }, 201);
    },
  ],

  'GET /api/projects/:id': [
    requireSession,
    async ({ params, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const [files, projectMembers] = await Promise.all([
        listAll<FileRecord>('project_files', { projectId: params.id }),
        listAll<MemberRecord>('project_members', { projectId: params.id }),
      ]);
      const members = projectMembers
        .map(member => ({
          ...memberView(member),
          role:
            member.userId === access.project.ownerId || member.role === 'owner'
              ? 'owner'
              : 'member',
        }));
      return json({ project: access.project, files, members });
    },
  ],

  'POST /api/projects/:id/files': [
    requireSession,
    async ({ params, body, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const input = (body || {}) as { name?: string; parentId?: string | null };
      const name = (input.name || '').trim();
      if (
        !/^[a-zA-Z0-9._-]{1,60}$/.test(name) ||
        name === '.' ||
        name === '..'
      ) {
        return error(
          'Use a filename with letters, numbers, dots, dashes or underscores (max 60 characters).',
          400
        );
      }
      let parentId: string | null = null;
      if (input.parentId) {
        const [parent] = await db.get<{ projectId: string }>(
          'project_folders',
          [input.parentId]
        );
        if (!parent || parent.projectId !== params.id)
          return error('Parent folder not found in this project.', 404);
        parentId = input.parentId;
      }
      const [projectFiles, projectFolders] = await Promise.all([
        listAll<FileRecord>('project_files', { projectId: params.id }),
        listAll<{ projectId: string; parentId?: string | null; name: string }>('project_folders', { projectId: params.id }),
      ]);
      const duplicateFile = projectFiles.some(
        file =>
          file.projectId === params.id &&
          (file.parentId || null) === parentId &&
          file.name.toLowerCase() === name.toLowerCase()
      );
      const duplicateFolder = projectFolders.some(
        folder =>
          folder.projectId === params.id &&
          (folder.parentId || null) === parentId &&
          folder.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicateFile || duplicateFolder) {
        return error('A file with that name already exists.', 409);
      }
      const record = {
        projectId: params.id,
        parentId,
        name,
        content: '',
        updatedAt: Date.now(),
      };
      const [id] = await db.add('project_files', [record]);
      if (!id) return error('Could not create the file.', 500);
      const file = { id, ...record };
      await notifySubscribers('project', params.id, {
        action: 'file-created',
        file,
      });
      return json({ file }, 201);
    },
  ],

  'PUT /api/projects/:id/files/:fileId': [
    requireSession,
    async ({ params, body, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const input = (body || {}) as {
        content?: string;
        connection_id?: string;
      };
      if (typeof input.content !== 'string' || input.content.length > 100000) {
        return error(
          'File content must be text and no larger than 100 KB.',
          400
        );
      }
      const [existing] = await db.get<FileRecord>('project_files', [
        params.fileId,
      ]);
      if (!existing || existing.projectId !== params.id)
        return error('File not found.', 404);
      const updatedAt = Date.now();
      const [updated] = await db.tx.update(
        'project_files',
        [
          {
            id: params.fileId,
            record: { content: input.content, updatedAt },
          },
        ],
        { patch: true }
      );
      if (!updated)
        return error(
          'The file changed before it could be saved. Please retry.',
          409
        );
      const file = {
        ...existing,
        content: input.content,
        updatedAt,
        id: params.fileId,
      };
      await notifySubscribers(
        'project',
        params.id,
        { action: 'file-updated', file },
        input.connection_id
      );
      return json({ file });
    },
  ],

  'DELETE /api/projects/:id/files/:fileId': [
    requireSession,
    async ({ params, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const [existing] = await db.get<FileRecord>('project_files', [
        params.fileId,
      ]);
      if (!existing || existing.projectId !== params.id)
        return error('File not found.', 404);
      const [deleted] = await db.delete('project_files', [params.fileId]);
      if (!deleted) return error('Could not delete the file.', 500);
      await notifySubscribers('project', params.id, {
        action: 'file-deleted',
        fileId: params.fileId,
      });
      return json({ ok: true });
    },
  ],

  'POST /api/projects/:id/subscribe': [
    requireSession,
    async ({ params, body, user }) => {
      const access = await requireProjectMember(params.id, user!.userId);
      if (!access)
        return error('Project not found or you do not have access.', 404);
      const input = (body || {}) as { connection_id?: string };
      if (!input.connection_id)
        return error('A live connection is required.', 400);
      await addSubscription('project', params.id, input.connection_id);
      return json({ ok: true });
    },
  ],

  'POST /api/projects/:id/unsubscribe': [
    requireSession,
    async ({ params, body, user }) => {
      const input = (body || {}) as { connection_id?: string };
      if (input.connection_id) {
        await removeSubscriptions('project', params.id, input.connection_id);
      }
      return json({ ok: true });
    },
  ],
});
