import { defineFunction } from '@aws-amplify/backend';

/**
 * Approve or deny an UnlockRequest. On approval, also unlocks the matching
 * Project. Authorisation: caller must be in the Cognito 'admin' group OR a
 * team-lead (in a 'team-<sub>' group) whose team matches the request.
 */
export const decideUnlockRequest = defineFunction({
  name: 'decide-unlock-request',
  entry: './handler.ts',
  timeoutSeconds: 30
});
