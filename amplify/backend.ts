import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { inviteUser } from './functions/invite-user/resource';
import { listAppUsers } from './functions/list-app-users/resource';
import { manageUser } from './functions/manage-user/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  inviteUser,
  listAppUsers,
  manageUser
});

const userPool = backend.auth.resources.userPool;

// ---- invite-user: create users, assign role group, and (for new Team Leads) ----
// auto-create their team Cognito group + set the custom:team attribute.
backend.inviteUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.inviteUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:CreateGroup'
    ],
    resources: [userPool.userPoolArn]
  })
);

// ---- list-app-users: read user list + group memberships ----
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

// ---- manage-user: reset passwords + delete users ----
backend.manageUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.manageUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminDeleteUser'
    ],
    resources: [userPool.userPoolArn]
  })
);
