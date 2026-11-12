import { db, json, error } from '@appdeploy/sdk';
import { requireSession } from './auth';
import { notifySubscribers } from './realtime-subscribers';
import { listAll } from './data';

type Member = { projectId: string; userId: string; role: string };
type Folder = {
  id?: string;
  projectId: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
};
type FileRecord = {
  id?: string;
  projectId: string;
  parentId?: string | null;
  name: string;
  content: string;
  updatedAt: number;
};

async function access(projectId: string, userId: string) {
  const matches = await listAll<Member>('project_members', {
    projectId,
    userId,
  });
  return matches[0] || null;
}
async function all<T>(table: string, projectId?: string) {
  return listAll<T>(table, projectId ? { projectId } : undefined);
}
function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 60 &&
    /^[\p{L}\p{N}._ -]+$/u.test(value.trim()) &&
    value.trim() !== '.' &&
    value.trim() !== '..'
  );
}
async function parent(
  projectId: string,
  value: unknown
): Promise<string | null | undefined> {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const [record] = await db.get<Folder>('project_folders', [value]);
  return record?.projectId === projectId ? value : undefined;
}
async function unique(
  projectId: string,
  parentId: string | null,
  name: string,
  exclude?: string
) {
  const [folders, files] = await Promise.all([
    all<Folder>('project_folders', projectId),
    all<FileRecord>('project_files', projectId),
  ]);
  return (
    !folders.some(
      x =>
        x.id !== exclude &&
        x.projectId === projectId &&
        (x.parentId || null) === parentId &&
        x.name.toLowerCase() === name.toLowerCase()
    ) &&
    !files.some(
      x =>
        x.id !== exclude &&
        x.projectId === projectId &&
        (x.parentId || null) === parentId &&
        x.name.toLowerCase() === name.toLowerCase()
    )
  );
}

export const workspaceRoutes = {
  'GET /api/projects/:id/folders': [
    requireSession,
    async ({ params, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      return json({
        folders: (await all<Folder>('project_folders')).filter(
          x => x.projectId === params.id
        ),
      });
    },
  ],
  'POST /api/projects/:id/folders': [
    requireSession,
    async ({ params, body, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const input = body || {};
      if (!validName(input.name))
        return error('Enter a valid folder name (1–60 characters).', 400);
      const parentId = await parent(params.id, input.parentId);
      if (parentId === undefined)
        return error('Parent folder not found in this project.', 404);
      const name = input.name.trim();
      if (!(await unique(params.id, parentId, name)))
        return error(
          'A file or folder with that name already exists here.',
          409
        );
      const now = Date.now();
      const record = {
        projectId: params.id,
        parentId,
        name,
        createdAt: now,
        updatedAt: now,
        createdBy: user!.userId,
      };
      const [id] = await db.add('project_folders', [record]);
      if (!id) return error('Could not create folder.', 500);
      const folder = { id, ...record };
      await notifySubscribers('project', params.id, {
        action: 'folder-created',
        folder,
      });
      return json({ folder }, 201);
    },
  ],
  'PATCH /api/projects/:id/folders/:folderId': [
    requireSession,
    async ({ params, body, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const [old] = await db.get<Folder>('project_folders', [params.folderId]);
      if (!old || old.projectId !== params.id)
        return error('Folder not found.', 404);
      const input = body || {};
      const name = input.name === undefined ? old.name : input.name;
      if (!validName(name))
        return error('Enter a valid folder name (1–60 characters).', 400);
      const parentId = await parent(
        params.id,
        input.parentId === undefined ? old.parentId : input.parentId
      );
      if (parentId === undefined)
        return error('Destination folder not found.', 404);
      const folders = (await all<Folder>('project_folders')).filter(
        x => x.projectId === params.id
      );
      const descendants = new Set([params.folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        folders.forEach(x => {
          if (
            x.parentId &&
            descendants.has(x.parentId) &&
            !descendants.has(x.id!)
          ) {
            descendants.add(x.id!);
            changed = true;
          }
        });
      }
      if (parentId && descendants.has(parentId))
        return error(
          'A folder cannot be moved inside itself or a child folder.',
          400
        );
      const cleanName = name.trim();
      if (!(await unique(params.id, parentId, cleanName, params.folderId)))
        return error(
          'A file or folder with that name already exists here.',
          409
        );
      const updatedAt = Date.now();
      const [ok] = await db.tx.update(
        'project_folders',
        [
          {
            id: params.folderId,
            record: { name: cleanName, parentId, updatedAt },
          },
        ],
        { patch: true }
      );
      if (!ok)
        return error('Folder changed before update. Refresh and retry.', 409);
      const folder = {
        ...old,
        id: params.folderId,
        name: cleanName,
        parentId,
        updatedAt,
      };
      await notifySubscribers('project', params.id, {
        action: 'folder-updated',
        folder,
      });
      return json({ folder });
    },
  ],
  'PUT /api/projects/:id/folders/:folderId': [
    requireSession,
    async ({ params, body, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const [old] = await db.get<Folder>('project_folders', [params.folderId]);
      if (!old || old.projectId !== params.id)
        return error('Folder not found.', 404);
      const input = body || {};
      const name = input.name === undefined ? old.name : input.name;
      if (!validName(name))
        return error('Enter a valid folder name (1–60 characters).', 400);
      const parentId = await parent(
        params.id,
        input.parentId === undefined ? old.parentId : input.parentId
      );
      if (parentId === undefined)
        return error('Destination folder not found.', 404);
      const folders = (await all<Folder>('project_folders')).filter(
        x => x.projectId === params.id
      );
      const descendants = new Set([params.folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        folders.forEach(x => {
          if (
            x.parentId &&
            descendants.has(x.parentId) &&
            !descendants.has(x.id!)
          ) {
            descendants.add(x.id!);
            changed = true;
          }
        });
      }
      if (parentId && descendants.has(parentId))
        return error(
          'A folder cannot be moved inside itself or a child folder.',
          400
        );
      const cleanName = name.trim();
      if (!(await unique(params.id, parentId, cleanName, params.folderId)))
        return error(
          'A file or folder with that name already exists here.',
          409
        );
      const updatedAt = Date.now();
      const [ok] = await db.tx.update(
        'project_folders',
        [
          {
            id: params.folderId,
            record: { name: cleanName, parentId, updatedAt },
          },
        ],
        { patch: true }
      );
      if (!ok)
        return error('Folder changed before update. Refresh and retry.', 409);
      const folder = {
        ...old,
        id: params.folderId,
        name: cleanName,
        parentId,
        updatedAt,
      };
      await notifySubscribers('project', params.id, {
        action: 'folder-updated',
        folder,
      });
      return json({ folder });
    },
  ],
  'DELETE /api/projects/:id/folders/:folderId': [
    requireSession,
    async ({ params, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const [root] = await db.get<Folder>('project_folders', [params.folderId]);
      if (!root || root.projectId !== params.id)
        return error('Folder not found.', 404);
      const [folders, files] = await Promise.all([
        all<Folder>('project_folders'),
        all<FileRecord>('project_files'),
      ]);
      const ids = new Set([params.folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        folders.forEach(x => {
          if (
            x.projectId === params.id &&
            x.parentId &&
            ids.has(x.parentId) &&
            !ids.has(x.id!)
          ) {
            ids.add(x.id!);
            changed = true;
          }
        });
      }
      const fileIds = files
        .filter(
          x => x.projectId === params.id && x.parentId && ids.has(x.parentId)
        )
        .map(x => x.id!);
      const folderIds = Array.from(ids);
      if (fileIds.length > 500 || folderIds.length > 500) {
        return error(
          'This folder tree is too large for one atomic delete. Remove some contents first.',
          413
        );
      }
      let deleteResults: boolean[][];
      try {
        const folderDelete = db.tx.delete('project_folders', folderIds);
        deleteResults = fileIds.length
          ? await db.transact([
              db.tx.delete('project_files', fileIds),
              folderDelete,
            ])
          : await db.transact([folderDelete]);
      } catch (err) {
        console.error('Atomic folder deletion failed or could not be confirmed.', err);
        return error(
          'Folder deletion failed or its outcome could not be confirmed. Refresh the workspace before retrying.',
          500
        );
      }
      if (deleteResults.some(operation => operation.some(deleted => !deleted))) {
        return error(
          'The folder contents changed during deletion. Refresh the workspace and retry.',
          409
        );
      }
      await notifySubscribers('project', params.id, {
        action: 'folder-deleted',
        folderIds,
        fileIds,
      });
      return json({ ok: true, folderIds, fileIds });
    },
  ],
  'PATCH /api/projects/:id/files/:fileId': [
    requireSession,
    async ({ params, body, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const [old] = await db.get<FileRecord>('project_files', [params.fileId]);
      if (!old || old.projectId !== params.id)
        return error('File not found.', 404);
      const input = body || {};
      const name = input.name === undefined ? old.name : input.name;
      if (!validName(name))
        return error('Enter a valid file name (1–60 characters).', 400);
      const parentId = await parent(
        params.id,
        input.parentId === undefined ? old.parentId : input.parentId
      );
      if (parentId === undefined)
        return error('Destination folder not found.', 404);
      const cleanName = name.trim();
      if (!(await unique(params.id, parentId, cleanName, params.fileId)))
        return error(
          'A file or folder with that name already exists here.',
          409
        );
      const updatedAt = Date.now();
      const [ok] = await db.tx.update(
        'project_files',
        [
          {
            id: params.fileId,
            record: { name: cleanName, parentId, updatedAt },
          },
        ],
        { patch: true }
      );
      if (!ok)
        return error('File changed before update. Refresh and retry.', 409);
      const file = {
        ...old,
        id: params.fileId,
        name: cleanName,
        parentId,
        updatedAt,
      };
      await notifySubscribers('project', params.id, {
        action: 'file-updated',
        file,
      });
      return json({ file });
    },
  ],
  'POST /api/projects/:id/files/:fileId/rename': [
    requireSession,
    async ({ params, body, user }: any) => {
      if (!(await access(params.id, user!.userId)))
        return error('Project not found or access denied.', 404);
      const [old] = await db.get<FileRecord>('project_files', [params.fileId]);
      if (!old || old.projectId !== params.id)
        return error('File not found.', 404);
      const input = body || {};
      const name = input.name === undefined ? old.name : input.name;
      if (!validName(name))
        return error('Enter a valid file name (1–60 characters).', 400);
      const parentId = await parent(
        params.id,
        input.parentId === undefined ? old.parentId : input.parentId
      );
      if (parentId === undefined)
        return error('Destination folder not found.', 404);
      const cleanName = name.trim();
      if (!(await unique(params.id, parentId, cleanName, params.fileId)))
        return error(
          'A file or folder with that name already exists here.',
          409
        );
      const updatedAt = Date.now();
      const [ok] = await db.tx.update(
        'project_files',
        [
          {
            id: params.fileId,
            record: { name: cleanName, parentId, updatedAt },
          },
        ],
        { patch: true }
      );
      if (!ok)
        return error('File changed before update. Refresh and retry.', 409);
      const file = {
        ...old,
        id: params.fileId,
        name: cleanName,
        parentId,
        updatedAt,
      };
      await notifySubscribers('project', params.id, {
        action: 'file-updated',
        file,
      });
      return json({ file });
    },
  ],
};
