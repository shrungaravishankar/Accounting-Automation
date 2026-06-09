import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool for BCL AutoLedger.
 *
 * Visibility tree:
 *   - 'admin'        → super-admin, sees every Level 1 User and their sub-users.
 *   - Level 1 User   → invited by Admin. Each Level 1 has their own Cognito
 *                       team group `team-<sub>`; only they are in it. They see
 *                       their sub-users' records via that group.
 *   - Sub-user       → invited by a Level 1 User. NOT in the team Cognito
 *                       group themselves (so they remain owner-scoped), but
 *                       their `custom:team` attribute tags every record they
 *                       create with the Level 1's group — so the Level 1 User
 *                       can see all of their sub-users' work.
 *
 * Email-based sign-in.
 */
export const auth = defineAuth({
  loginWith: {
    email: true
  },
  userAttributes: {
    fullname: { required: true, mutable: true },
    // Cognito custom attribute storing the team group name for each user.
    // Admins leave it blank; Team Leads set it to their own team-<sub>;
    // Members inherit their Team Lead's team-<sub>.
    'custom:team': { dataType: 'String', mutable: true, minLen: 0, maxLen: 80 }
  },
  // 'admin' = Super Admin. 'team-lead' = Admin (flat group of all team leads,
  // each also in their own team-<sub> Cognito group). 'staff' = User. Each
  // group needs to be declared here so CDK provisions an IAM role for it;
  // storage and data rules can then reference the group by name.
  groups: ['admin', 'team-lead', 'staff']
});
