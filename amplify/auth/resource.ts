import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito User Pool for BCL AutoLedger.
 * Two groups: 'admin' and 'staff'.
 * Email-based sign-in.
 */
export const auth = defineAuth({
  loginWith: {
    email: true
  },
  userAttributes: {
    fullname: { required: true, mutable: true }
  },
  groups: ['admin', 'staff']
});
