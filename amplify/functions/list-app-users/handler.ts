declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

type UserRow = {
  email: string;
  name: string;
  role: string;             // 'admin' | 'team-lead' | 'staff' | 'none'
  status: string;
  enabled: boolean;
  createdAt: string;
  team: string;             // the team group the user belongs to (or "")
};

type ListEvent = {
  identity?: {
    sub?: string;
    groups?: string[];
    username?: string;
  };
};

export const handler = async (event: ListEvent) => {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return { error: 'USER_POOL_ID missing', users: [] as UserRow[] };

  const callerGroups = event.identity?.groups || [];
  const isAdmin = callerGroups.includes('admin');
  const callerTeam = callerGroups.find(g => g.startsWith('team-')) || '';

  if (!isAdmin && !callerTeam) {
    return { error: 'Not authorized to view users.', users: [] as UserRow[] };
  }

  try {
    const listResp = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60 }));

    const rows: UserRow[] = [];
    for (const u of listResp.Users || []) {
      const email = u.Attributes?.find(a => a.Name === 'email')?.Value || u.Username || '';
      const name = u.Attributes?.find(a => a.Name === 'name')?.Value || '';
      const teamAttr = u.Attributes?.find(a => a.Name === 'custom:team')?.Value || '';

      // Fetch this user's Cognito groups to derive role + (for Team Leads) their team group.
      let role: 'admin' | 'team-lead' | 'staff' | 'none' = 'none';
      let teamFromGroup = '';
      try {
        const grps = await cognito.send(new AdminListGroupsForUserCommand({
          UserPoolId: userPoolId,
          Username: u.Username!
        }));
        const groupNames = (grps.Groups || []).map(g => g.GroupName).filter((g): g is string => !!g);
        if (groupNames.includes('admin')) role = 'admin';
        else if (groupNames.some(g => g.startsWith('team-'))) role = 'team-lead';
        else if (groupNames.includes('staff')) role = 'staff';
        teamFromGroup = groupNames.find(g => g.startsWith('team-')) || '';
      } catch (_) { /* ignore per-user group fetch errors */ }

      // Team Lead's own team group wins; otherwise use custom:team (Members inherit it).
      const team = teamFromGroup || teamAttr;

      rows.push({
        email,
        name,
        role,
        status: u.UserStatus || 'UNKNOWN',
        enabled: u.Enabled !== false,
        createdAt: u.UserCreateDate ? u.UserCreateDate.toISOString() : '',
        team
      });
    }

    // Scope the result: a Team Lead sees only their team (themselves + members).
    const visible = isAdmin
      ? rows
      : rows.filter(r => r.team === callerTeam);

    // Sort: pending invites first, then by name.
    visible.sort((a, b) => {
      const pa = a.status === 'FORCE_CHANGE_PASSWORD' ? 0 : 1;
      const pb = b.status === 'FORCE_CHANGE_PASSWORD' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });

    return { error: null, users: visible };
  } catch (err: any) {
    return { error: err?.message || 'Failed to list users.', users: [] as UserRow[] };
  }
};
