import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool for BCL AutoLedger.
 *
 * Role hierarchy (visibility/access from highest to lowest):
 *   - 'admin'     → super-admin, can manage users.
 *   - 'manager'   → sees and edits everyone's clients/projects.
 *   - 'team-lead' → sees and edits everyone's clients/projects.
 *   - 'staff'     → "Executive" in the UI: owner-scoped (sees only own work).
 *
 * Email-based sign-in.
 */
export const auth = defineAuth({
  loginWith: {
    email: true
  },
  userAttributes: {
    fullname: { required: true, mutable: true }
  },
  groups: ['admin', 'manager', 'team-lead', 'staff']
});
