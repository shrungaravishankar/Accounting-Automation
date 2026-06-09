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
  // Only CDK-managed groups go here. 'team-lead' is a runtime-only group
  // created by the invite-user / manage-user Lambdas — it carries no IAM
  // role (Lambdas authorise off the JWT cognito:groups claim, not the
  // assumed role), so declaring it here would clash with the existing
  // runtime group and fail the deploy.
  groups: ['admin', 'staff']
});
