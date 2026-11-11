import { db, json, error, secrets } from '@appdeploy/sdk';
import { requireSession } from './auth';

type ProviderKey = 'github' | 'vercel' | 'netlify' | 'render';

const providers: Array<{
  key: ProviderKey;
  secret: string;
  url: string;
  headers: (token: string) => Record<string, string>;
  accountName: (data: any) => string;
}> = [
  {
    key: 'github',
    secret: 'NOVA_GITHUB_TOKEN',
    url: 'https://api.github.com/user',
    headers: token => ({
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'NOVA-IDE',
    }),
    accountName: data => data.login || data.name || '',
  },
  {
    key: 'vercel',
    secret: 'NOVA_VERCEL_TOKEN',
    url: 'https://api.vercel.com/v2/user',
    headers: token => ({
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    }),
    accountName: data =>
      data.user?.username || data.user?.name || data.username || '',
  },
  {
    key: 'netlify',
    secret: 'NOVA_NETLIFY_TOKEN',
    url: 'https://api.netlify.com/api/v1/user',
    headers: token => ({
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    }),
    accountName: data => data.full_name || data.email || data.slug || '',
  },
  {
    key: 'render',
    secret: 'NOVA_RENDER_API_KEY',
    url: 'https://api.render.com/v1/owners?limit=1',
    headers: token => ({
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    }),
    accountName: data =>
      Array.isArray(data)
        ? data[0]?.owner?.name || data[0]?.owner?.email || data[0]?.name || ''
        : data.name || data.email || '',
  },
];

async function verifyProvider(
  provider: (typeof providers)[number],
  configuredNames: string[]
) {
  if (!configuredNames.includes(provider.secret)) {
    return {
      configured: false,
      connected: false,
      message: 'Credential not configured',
    };
  }
  try {
    const token = await secrets.readSecret(provider.secret);
    const response = await fetch(provider.url, {
      method: 'GET',
      signal: AbortSignal.timeout(12000),
      headers: provider.headers(token),
    });
    if (!response.ok) {
      return {
        configured: true,
        connected: false,
        message:
          'Provider rejected the credential (HTTP ' + response.status + ')',
      };
    }
    const data = await response.json().catch(() => ({}));
    const account = provider.accountName(data);
    return {
      configured: true,
      connected: true,
      message: account
        ? 'Connected as ' + String(account).slice(0, 80)
        : 'Credential accepted by provider',
    };
  } catch {
    return {
      configured: true,
      connected: false,
      message: 'Could not verify this provider right now',
    };
  }
}

export const deploymentIntegrationRoutes = {
  'POST /api/projects/:id/deployment-integrations/verify': [
    requireSession,
    async ({ params, user }: any) => {
      const [project] = await db.get<{ ownerId: string }>('projects', [
        params.id,
      ]);
      if (!project) return error('Project not found or access denied.', 404);
      const { items } = await db.list<{
        projectId: string;
        userId: string;
        role: string;
      }>('project_members', { limit: 500 });
      const membership = items.find(
        item => item.projectId === params.id && item.userId === user!.userId
      );
      if (!membership) return error('Project not found or access denied.', 404);
      if (project.ownerId !== user!.userId && membership.role !== 'owner') {
        return error(
          'Only the project owner can verify shared provider credentials.',
          403
        );
      }
      const configuredNames = await secrets.listSecretNames();
      const results = await Promise.all(
        providers.map(async provider => ({
          provider: provider.key,
          ...(await verifyProvider(provider, configuredNames)),
        }))
      );
      return json({ providers: results, checkedAt: Date.now() });
    },
  ],
};
