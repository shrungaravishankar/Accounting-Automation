declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient();

type ListEvent = {
  identity?: {
    groups?: string[];
    username?: string;
  };
};

type UserRow = {
  email: string;
  name: string;
  role: string;
  status: string;
  enabled: boolean;
  createdAt: string;
};

export const handler = async (event: ListEvent) => {
  // ---- Authorization: only admins ----
  const callerGroups = event.identity?.groups || [];
  if (!callerGroups.includes('admin')) {
    return {
      error: 'Unauthorized: only admins can view users.',
      users: [] as UserRow[]
    };
  }

  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
    return { error: 'USER_POOL_ID missing', users: [] as UserRow[] };
  }

  try {
    const listResp = await client.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Limit: 60
    }));

    const rows: UserRow[] = [];

    for (const u of listResp.Users || []) {
      const email =
        u.Attributes?.find((a) => a.Name === 'email')?.Value ||
        u.Username ||
        '';
      const name =
        u.Attributes?.find((a) => a.Name === 'name')?.Value || '';

      let role = 'none';
      try {
        const grps = await client.send(
          new AdminListGroupsForUserCommand({
            UserPoolId: userPoolId,
            Username: u.Username!
          })
        );
        const groupNames = (grps.Groups || [])
          .map((g) => g.GroupName)
          .filter((g): g is string => !!g);
        if (groupNames.includes('admin')) role = 'admin';
        else if (groupNames.includes('staff')) role = 'staff';
      } catch (_) {
        // ignore per-user group fetch errors
      }

      rows.push({
        email,
        name,
        role,
        status: u.UserStatus || 'UNKNOWN',
        enabled: u.Enabled !== false,
        createdAt: u.UserCreateDate
          ? u.UserCreateDate.toISOString()
          : ''
      });
    }

    // Sort: pending invites first, then by name
    rows.sort((a, b) => {
      const pendA = a.status === 'FORCE_CHANGE_PASSWORD' ? 0 : 1;
      const pendB = b.status === 'FORCE_CHANGE_PASSWORD' ? 0 : 1;
      if (pendA !== pendB) return pendA - pendB;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });

    return { error: null, users: rows };
  } catch (err: any) {
    return {
      error: err?.message || 'Failed to list users.',
      users: [] as UserRow[]
    };
  }
};
