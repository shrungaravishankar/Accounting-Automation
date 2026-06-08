import { defineFunction } from '@aws-amplify/backend';

/**
 * Returns Projects / Clients / ExportLogs / UnlockRequests visible to the
 * caller based on their Cognito team group. Used to give team-lead Admins
 * visibility into work created by their team members.
 */
export const listTeamData = defineFunction({
  name: 'list-team-data',
  entry: './handler.ts',
  timeoutSeconds: 30,
  // Co-locate with the data stack to break the circular dependency:
  // this function is an AppSync resolver AND reads the DynamoDB tables
  // that live in the data stack.
  resourceGroupName: 'data'
});
