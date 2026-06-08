import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';

declare const process: { env: Record<string, string | undefined> };

type Event = {
  arguments: { requestId: string; approve: boolean };
  identity?: { username?: string; groups?: string[]; claims?: Record<string, any> };
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

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  const teamGroup = groups.find(g => g.startsWith('team-')) || '';
  const callerEmail = (event.identity?.claims as any)?.email || event.identity?.username || '';

  if (!isSuperAdmin && !teamGroup) {
    return { success: false, message: 'Not authorized to decide unlock requests.' };
  }

  const requestId = event.arguments?.requestId;
  const approve = !!event.arguments?.approve;
  if (!requestId) return { success: false, message: 'requestId is required.' };

  try {
    const client = await getClient();

    // 1) Load the request and check team-scope authorisation.
    const reqRes = await client.models.UnlockRequest.get({ id: requestId });
    if (reqRes.errors?.length || !reqRes.data) {
      return { success: false, message: reqRes.errors?.[0]?.message || 'Unlock request not found.' };
    }
    const req = reqRes.data;

    if (!isSuperAdmin && req.team !== teamGroup) {
      return { success: false, message: 'You can only decide unlock requests for your own team.' };
    }
    if (req.status && req.status !== 'pending') {
      return { success: false, message: 'This request has already been ' + req.status + '.' };
    }

    // 2) On approval, unlock the project.
    if (approve && req.projectId) {
      const upd = await client.models.Project.update({ id: req.projectId, locked: false });
      if (upd.errors?.length) {
        return { success: false, message: 'Could not unlock project: ' + upd.errors[0].message };
      }
    }

    // 3) Mark the request decided.
    const reqUpd = await client.models.UnlockRequest.update({
      id: requestId,
      status: approve ? 'approved' : 'denied',
      decidedByEmail: callerEmail,
      decidedAt: new Date().toISOString()
    });
    if (reqUpd.errors?.length) {
      return { success: false, message: 'Decision saved partially: ' + reqUpd.errors[0].message };
    }

    return { success: true, message: approve ? 'Project unlocked.' : 'Request denied.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'decide-unlock-request failed' };
  }
};
