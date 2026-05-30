declare const process: { env: Record<string, string | undefined> };

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
  CreateGroupCommand,
  UsernameExistsException,
  GroupExistsException
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient();

/**
 * Hierarchy rules:
 *   - An Admin invitee always becomes another Admin (no team).
 *   - When the inviter is the platform Admin, the new user becomes a
 *     Team Lead: we create their team Cognito group (team-<sub>) and add
 *     them to it.
 *   - When the inviter is a Team Lead, the new user becomes a Member of
 *     the inviter's team: we tag custom:team but do NOT add them to the
 *     team group (so they stay owner-scoped — only their Team Lead and
 *     Admin can see their work).
 */
type InviteEvent = {
  arguments: {
    email: string;
    fullName: string;
    role: string; // 'admin' | 'team-lead' | 'member' (semantic — actual group mapping done below)
  };
  identity?: {
    sub?: string;
    groups?: string[];
    username?: string;
  };
};

export const handler = async (event: InviteEvent) => {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
    return { success: false, message: 'Server misconfiguration: USER_POOL_ID missing.' };
  }

  const callerGroups = event.identity?.groups || [];
  const isAdmin = callerGroups.includes('admin');
  const callerTeamGroup = callerGroups.find(g => g.startsWith('team-'));
  const isTeamLead = !isAdmin && !!callerTeamGroup;

  if (!isAdmin && !isTeamLead) {
    return { success: false, message: 'Only admins or team leads can invite users.' };
  }

  const email = (event.arguments?.email || '').trim().toLowerCase();
  const fullName = (event.arguments?.fullName || '').trim();
  const requestedRole = (event.arguments?.role || '').trim();
  if (!email || !fullName) {
    return { success: false, message: 'Email and full name are required.' };
  }

  // Decide the effective invitee role + behaviour.
  // 'inviteeRoleGroup' is the Cognito role group: 'admin' or 'staff'.
  // 'createTeamForInvitee' = true means we auto-create team-<sub> and add the
  // invitee to it (i.e. they become a Team Lead).
  // 'inheritedTeamGroup' is the team group string to stamp into custom:team
  // for Members; empty for Admins.
  let inviteeRoleGroup: 'admin' | 'staff';
  let createTeamForInvitee = false;
  let inheritedTeamGroup = '';

  if (isAdmin) {
    if (requestedRole === 'admin') {
      inviteeRoleGroup = 'admin';
      createTeamForInvitee = false;
      inheritedTeamGroup = ''; // admins are team-agnostic
    } else {
      // Anything else from an admin = create a new Team Lead.
      inviteeRoleGroup = 'staff';
      createTeamForInvitee = true;
    }
  } else {
    // Team Lead invite → always a Member of the inviter's team.
    if (requestedRole === 'admin' || requestedRole === 'team-lead') {
      return { success: false, message: 'Team leads can only invite Members.' };
    }
    inviteeRoleGroup = 'staff';
    createTeamForInvitee = false;
    inheritedTeamGroup = callerTeamGroup!;
  }

  try {
    // Step 1: create the user (custom:team set up-front if we know it).
    const createRes = await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: fullName },
        ...(inheritedTeamGroup ? [{ Name: 'custom:team', Value: inheritedTeamGroup }] : [])
      ],
      DesiredDeliveryMediums: ['EMAIL']
    }));

    // Step 2: add to role Cognito group ('admin' or 'staff').
    await client.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: inviteeRoleGroup
    }));

    // Step 3: if this is a new Team Lead, create their team group + add them.
    if (createTeamForInvitee) {
      const newSub =
        createRes.User?.Attributes?.find(a => a.Name === 'sub')?.Value || '';
      if (!newSub) {
        return {
          success: true,
          message: `Invitation sent to ${email}, but team group could not be created (no sub returned). Contact an admin.`
        };
      }
      const teamGroup = `team-${newSub}`;
      try {
        await client.send(new CreateGroupCommand({
          UserPoolId: userPoolId,
          GroupName: teamGroup,
          Description: `Team led by ${email}`
        }));
      } catch (err: any) {
        if (!(err instanceof GroupExistsException)) throw err;
      }
      await client.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: teamGroup
      }));
      await client.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [{ Name: 'custom:team', Value: teamGroup }]
      }));
    }

    return {
      success: true,
      message: `Invitation sent to ${email}. They'll receive a temporary password by email.`
    };
  } catch (err: any) {
    if (err instanceof UsernameExistsException) {
      return { success: false, message: 'A user with this email already exists.' };
    }
    return { success: false, message: err?.message || 'Failed to invite user.' };
  }
};
