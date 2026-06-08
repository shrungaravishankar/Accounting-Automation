declare const process: { env: Record<string, string | undefined> };

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type Event = {
  arguments: { requestId: string; approve: boolean };
  identity?: { username?: string; groups?: string[]; claims?: Record<string, any> };
};

export const handler = async (event: Event) => {
  const groups = event.identity?.groups || [];
  const isSuperAdmin = groups.includes('admin');
  const teamGroup = groups.find(g => g.startsWith('team-')) || '';
  const claims = (event.identity?.claims || {}) as any;
  const callerEmail = claims.email || event.identity?.username || '';

  if (!isSuperAdmin && !teamGroup) {
    return JSON.stringify({ success: false, message: 'Not authorized to decide unlock requests.' });
  }

  const requestId = event.arguments?.requestId;
  const approve = !!event.arguments?.approve;
  if (!requestId) return JSON.stringify({ success: false, message: 'requestId is required.' });

  const unlockTable = process.env.UNLOCKREQUEST_TABLE_NAME;
  const projectTable = process.env.PROJECT_TABLE_NAME;
  if (!unlockTable || !projectTable) {
    return JSON.stringify({ success: false, message: 'Table env vars not configured.' });
  }

  try {
    // 1) Load the request and check team-scope authorisation.
    const reqRes = await ddb.send(new GetCommand({ TableName: unlockTable, Key: { id: requestId } }));
    const req = reqRes.Item;
    if (!req) return JSON.stringify({ success: false, message: 'Unlock request not found.' });

    if (!isSuperAdmin && req.team !== teamGroup) {
      return JSON.stringify({ success: false, message: 'You can only decide unlock requests for your own team.' });
    }
    if (req.status && req.status !== 'pending') {
      return JSON.stringify({ success: false, message: 'This request has already been ' + req.status + '.' });
    }

    // 2) On approval, unlock the project.
    if (approve && req.projectId) {
      await ddb.send(new UpdateCommand({
        TableName: projectTable,
        Key: { id: req.projectId },
        UpdateExpression: 'SET locked = :f',
        ExpressionAttributeValues: { ':f': false }
      }));
    }

    // 3) Mark the request decided.
    await ddb.send(new UpdateCommand({
      TableName: unlockTable,
      Key: { id: requestId },
      UpdateExpression: 'SET #s = :s, decidedByEmail = :e, decidedAt = :t',
      ExpressionAttributeValues: {
        ':s': approve ? 'approved' : 'denied',
        ':e': callerEmail,
        ':t': new Date().toISOString()
      },
      ExpressionAttributeNames: { '#s': 'status' }
    }));

    return JSON.stringify({ success: true, message: approve ? 'Project unlocked.' : 'Request denied.' });
  } catch (err: any) {
    return JSON.stringify({ success: false, message: err?.message || 'decide-unlock-request failed' });
  }
};
