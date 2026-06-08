import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';

declare const process: { env: Record<string, string | undefined> };

type Kind = 'projects' | 'clients' | 'exportLogs' | 'unlockRequests';

type Event = {
  arguments: { kind: Kind; clientId?: string };
  identity?: { username?: string; groups?: string[] };
};

let configured = false;
async function getClient() {
  if (!configured) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(process.env as any);
    Amplify.configure(resourceConfig, libraryOptions);
    configured = true;
  }
  return generateClient<Schema>({ authMode: 'iam' });
}

async function listAll<T>(fn: (token?: string) => Promise<{ data: T[]; nextToken?: string | null; errors?: any[] }>) {
  const out: T[] = [];
  let nextToken: string | undefined = undefined;
  do {
    const res = await fn(nextToken);
    if (res.errors?.length) throw new Error(res.errors[0].message || 'list failed');
    out.push(...(res.data || []));
    nextToken = res.nextToken || undefined;
  } while (nextToken);
  return out;
}

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  const teamGroup = groups.find(g => g.startsWith('team-')) || '';

  // Members aren't admins and aren't in a team group — they only see their own
  // rows via the owner rule. This Lambda is for admins / team-leads only.
  if (!isSuperAdmin && !teamGroup) {
    return { error: 'Not authorized to list team data.', items: [] };
  }

  const kind = event.arguments?.kind;
  const clientId = event.arguments?.clientId;
  if (!kind) return { error: 'kind is required', items: [] };

  try {
    const client = await getClient();
    const teamFilter = (rows: any[]) => isSuperAdmin ? rows : rows.filter(r => r.team === teamGroup);

    if (kind === 'projects') {
      if (!clientId) return { error: 'clientId is required for kind=projects', items: [] };
      const rows = await listAll((token) =>
        client.models.Project.list({ filter: { clientId: { eq: clientId } }, limit: 200, nextToken: token })
      );
      return { error: null, items: teamFilter(rows) };
    }
    if (kind === 'clients') {
      const rows = await listAll((token) => client.models.Client.list({ limit: 200, nextToken: token }));
      return { error: null, items: teamFilter(rows) };
    }
    if (kind === 'exportLogs') {
      const rows = await listAll((token) => client.models.ExportLog.list({ limit: 200, nextToken: token }));
      return { error: null, items: teamFilter(rows) };
    }
    if (kind === 'unlockRequests') {
      const rows = await listAll((token) =>
        client.models.UnlockRequest.list({ filter: { status: { eq: 'pending' } }, limit: 200, nextToken: token })
      );
      return { error: null, items: teamFilter(rows) };
    }
    return { error: 'unknown kind: ' + kind, items: [] };
  } catch (err: any) {
    return { error: err?.message || 'list-team-data failed', items: [] };
  }
};
