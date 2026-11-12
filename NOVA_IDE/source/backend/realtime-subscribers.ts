import { db, ws, json, error } from '@appdeploy/sdk';
import { listAll } from './data';

const SUBSCRIPTIONS_TABLE = 'entity_subscriptions';

export type SubscriptionRecord = {
  id: string;
  entity_type: string;
  entity_id: string;
  connection_id: string;
  created_at: number;
};

async function listSubscriptions(
  filter?: Record<string, unknown>,
  maxItems = 20000
): Promise<SubscriptionRecord[]> {
  return listAll<SubscriptionRecord>(SUBSCRIPTIONS_TABLE, filter, maxItems);
}

async function deleteSubscriptionIds(ids: string[]) {
  for (let offset = 0; offset < ids.length; offset += 500) {
    const results = await db.delete(
      SUBSCRIPTIONS_TABLE,
      ids.slice(offset, offset + 500)
    );
    if (results.some(result => !result))
      throw new Error('Could not remove all realtime subscriptions.');
  }
}

export async function removeSubscriptionsByConnection(connectionId: string) {
  const items = await listSubscriptions({ connection_id: connectionId });
  const matchIds = items.map(item => item.id);
  if (matchIds.length > 0) {
    await deleteSubscriptionIds(matchIds);
  }
}

export async function addSubscription(
  entityType: string,
  entityId: string,
  connectionId: string
) {
  await db.add(SUBSCRIPTIONS_TABLE, [
    {
      entity_type: entityType,
      entity_id: entityId,
      connection_id: connectionId,
      created_at: Date.now(),
    },
  ]);
}

export async function removeSubscriptions(
  entityType: string,
  entityId: string,
  connectionId: string
) {
  const items = await listSubscriptions({
    entity_type: entityType,
    entity_id: entityId,
    connection_id: connectionId,
  });
  const matchIds = items.map(item => item.id);
  if (matchIds.length > 0) {
    await deleteSubscriptionIds(matchIds);
  }
}

export async function notifySubscribers(
  entityType: string,
  entityId: string,
  payload: unknown,
  excludeConnectionId?: string
) {
  const items = await listSubscriptions({
    entity_type: entityType,
    entity_id: entityId,
  });
  const targets = items
    .map(item => item.connection_id)
    .filter(id => id !== excludeConnectionId);
  const targetConnectionIds = Array.from(new Set(targets));

  if (targetConnectionIds.length === 0) {
    return;
  }

  await ws.send(targetConnectionIds, {
    v: 1,
    type: 'entity.update',
    payload: {
      entity_type: entityType,
      entity_id: entityId,
      data: payload,
    },
  });
}

export const realtimeSubscriptionRoutes = {
  'POST /api/subscriptions': [
    async ({ body }) => {
      const { entity_type, entity_id, connection_id } = (body || {}) as Record<
        string,
        string
      >;
      if (!entity_type || !entity_id || !connection_id) {
        return error('entity_type, entity_id, connection_id are required');
      }
      await addSubscription(entity_type, entity_id, connection_id);
      return json({ ok: true });
    },
  ],

  'POST /api/subscriptions/remove': [
    async ({ body }) => {
      const { entity_type, entity_id, connection_id } = (body || {}) as Record<
        string,
        string
      >;
      if (!entity_type || !entity_id || !connection_id) {
        return error('entity_type, entity_id, connection_id are required');
      }
      await removeSubscriptions(entity_type, entity_id, connection_id);
      return json({ ok: true });
    },
  ],
};
