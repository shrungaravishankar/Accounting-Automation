import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { inviteUser } from './functions/invite-user/resource';
import { listAppUsers } from './functions/list-app-users/resource';

const backend = defineBackend({
  auth,
  data,
  inviteUser,
  listAppUsers
});

const userPool = backend.auth.resources.userPool;

// ---- invite-user: needs to create users and assign them to groups ----
backend.inviteUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.inviteUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminAddUserToGroup'
    ],
    resources: [userPool.userPoolArn]
  })
);

// ---- list-app-users: needs to list users and read their group memberships ----
backend.listAppUsers.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.listAppUsers.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:ListUsers',
      'cognito-idp:AdminListGroupsForUser'
    ],
    resources: [userPool.userPoolArn]
  })
);
