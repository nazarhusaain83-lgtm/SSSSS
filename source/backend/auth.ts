import { db, json, error, secrets } from '@appdeploy/sdk';
import { listAll } from './data';

type SessionPayload = {
  userId: string;
  name: string;
  role: 'admin' | 'member';
  exp: number;
};
type AccountRecord = {
  id?: string;
  userId: string;
  username: string;
  name: string;
  passwordHash: string;
  role: 'member';
  createdAt: number;
};

const ADMIN_SECRET_NAMES: Record<string, string> = {
  'sc@11': 'NOVA_ADMIN_SC_PASSWORD',
  'np@11': 'NOVA_ADMIN_NP_PASSWORD',
  'ss@11': 'NOVA_ADMIN_SS_PASSWORD',
};
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function sessionKey() {
  const secret = await secrets.readSecret('NOVA_SESSION_SIGNING_SECRET');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Session signing secret is missing or too short.');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}
async function createSession(payload: Omit<SessionPayload, 'exp'>) {
  const body = toBase64Url(encoder.encode(JSON.stringify({
    ...payload,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })));
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(), encoder.encode(body));
  return body + '.' + toBase64Url(new Uint8Array(signature));
}
async function readSession(event: any): Promise<SessionPayload | null> {
  const header = event?.headers?.cookie || event?.headers?.Cookie || '';
  const cookie = String(header).split(';').map((part: string) => part.trim())
    .find((part: string) => part.startsWith('nova_session='));
  if (!cookie) return null;
  const token = cookie.slice('nova_session='.length);
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await sessionKey(),
      fromBase64Url(signature),
      encoder.encode(body)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Partial<SessionPayload>;
    if (
      typeof payload.userId !== 'string' || !payload.userId ||
      typeof payload.name !== 'string' || !payload.name ||
      (payload.role !== 'admin' && payload.role !== 'member') ||
      typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
      payload.exp <= Date.now()
    ) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
export async function requireSession(ctx: any) {
  const session = await readSession(ctx.event);
  if (!session) return error('Please sign in to continue.', 401);
  ctx.user = {
    userId: session.userId,
    name: session.name,
    scope: session.role,
  };
}
function sessionCookie(token: string) {
  return 'nova_session=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800';
}
function clearSessionCookie() {
  return 'nova_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
function randomSalt() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
async function hashPassword(password: string, saltText = randomSalt()) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: fromBase64Url(saltText),
    iterations: 210000,
    hash: 'SHA-256',
  }, material, 256);
  return saltText + '$' + toBase64Url(new Uint8Array(bits));
}
async function verifyPassword(password: string, stored: string) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 2) return false;
  const [salt, expected] = parts;
  if (
    !salt || !expected ||
    !/^[A-Za-z0-9_-]{20,32}$/.test(salt) ||
    !/^[A-Za-z0-9_-]{43}$/.test(expected)
  ) return false;
  const actual = (await hashPassword(password, salt)).split('$')[1];
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export const authRoutes = {
  'POST /api/auth/login': [
    async ({ body }: any) => {
      const input = (body && typeof body === 'object' ? body : {}) as {
        username?: unknown;
        password?: unknown;
      };
      const username = typeof input.username === 'string' ? input.username.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!username || !password || username.length > 32 || password.length > 256) {
        return error('Enter your username and password.', 400);
      }
      const normalized = username.toLowerCase();
      let account: { userId: string; name: string; role: 'admin' | 'member' } | null = null;
      const secretName = ADMIN_SECRET_NAMES[normalized];
      if (secretName) {
        const expected = await secrets.readSecret(secretName);
        if (password === expected) {
          account = {
            userId: 'nova-admin-' + normalized.replace(/[^a-z0-9]/g, '-'),
            name: username,
            role: 'admin',
          };
        }
      } else {
        const items = await listAll<AccountRecord>('nova_accounts');
        const saved = items.find(item => item.username.toLowerCase() === normalized);
        if (saved && await verifyPassword(password, saved.passwordHash)) {
          account = { userId: saved.userId, name: saved.name, role: 'member' };
        }
      }
      if (!account) return error('Username or password is incorrect.', 401);
      const token = await createSession(account);
      const response = json({ user: { ...account, username } });
      response.headers['Set-Cookie'] = sessionCookie(token);
      return response;
    },
  ],
  'POST /api/auth/logout': [
    async () => {
      const response = json({ ok: true });
      response.headers['Set-Cookie'] = clearSessionCookie();
      return response;
    },
  ],
  'GET /api/auth/me': [
    async ({ event }: any) => {
      const session = await readSession(event);
      if (!session) return json({ user: null });
      return json({
        user: {
          userId: session.userId,
          name: session.name,
          username: session.name,
          role: session.role,
        },
      });
    },
  ],
  'GET /api/admin/users': [
    requireSession,
    async ({ user }: any) => {
      if (user!.scope !== 'admin') return error('Administrator access is required.', 403);
      const items = await listAll<AccountRecord>('nova_accounts');
      return json({
        users: items.map(item => ({
          userId: item.userId,
          username: item.username,
          name: item.name,
          role: item.role,
          createdAt: item.createdAt,
        })),
      });
    },
  ],
  'POST /api/admin/users': [
    requireSession,
    async ({ body, user }: any) => {
      if (user!.scope !== 'admin') return error('Only administrators can create accounts.', 403);
      const input = (body && typeof body === 'object' ? body : {}) as {
        username?: unknown;
        password?: unknown;
        name?: unknown;
      };
      const username = typeof input.username === 'string' ? input.username.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      const name = typeof input.name === 'string' ? input.name.trim() : username;
      if (!/^[A-Za-z0-9@._-]{3,32}$/.test(username)) {
        return error('Username must be 3–32 characters using letters, numbers, @, dots, dashes or underscores.', 400);
      }
      if (password.length < 12 || password.length > 256) {
        return error('New account passwords must be at least 12 characters.', 400);
      }
      const normalized = username.toLowerCase();
      const items = await listAll<AccountRecord>('nova_accounts');
      if (
        Object.prototype.hasOwnProperty.call(ADMIN_SECRET_NAMES, normalized) ||
        items.some(item => item.username.toLowerCase() === normalized)
      ) return error('That username is already in use.', 409);

      const userId = 'nova-user-' + toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
      const record = {
        userId,
        username,
        name: name.slice(0, 48),
        passwordHash: await hashPassword(password),
        role: 'member' as const,
        createdAt: Date.now(),
      };
      // A deterministic physical ID closes the concurrent duplicate-username race.
      const accountId = 'account_' + toBase64Url(encoder.encode(normalized));
      const [id] = await db.tx.add('nova_accounts', [{ id: accountId, ...record }]);
      if (!id) return error('That username is already in use.', 409);
      return json({
        user: {
          userId,
          username: record.username,
          name: record.name,
          role: record.role,
          createdAt: record.createdAt,
        },
      }, 201);
    },
  ],
};
