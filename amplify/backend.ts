import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { inviteUser } from './functions/invite-user/resource';

const backend = defineBackend({
  auth,
  data,
  inviteUser
});

// Pass the User Pool ID to the Lambda as an env var.
const userPool = backend.auth.resources.userPool;
backend.inviteUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);

// Grant the Lambda permission to create users and add them to groups
// inside *this* user pool only.
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
