import { db } from '@appdeploy/sdk';

/** Read every matching record through bounded database pages. */
export async function listAll<T = Record<string, unknown>>(
  table: string,
  filter?: Record<string, unknown>,
  maxItems = 10000
): Promise<T[]> {
  const items: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await db.list<T>(table, {
      limit: 500,
      ...(filter ? { filter } : {}),
      ...(nextToken ? { nextToken } : {}),
    });
    items.push(...page.items);
    if (items.length > maxItems) {
      throw new Error(
        'The ' +
          table +
          ' result exceeds the safe read limit. Narrow the operation and retry.'
      );
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}
