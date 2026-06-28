import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { inviteUser } from './functions/invite-user/resource';
import { listAppUsers } from './functions/list-app-users/resource';
import { manageUser } from './functions/manage-user/resource';
import { listTeamData } from './functions/list-team-data/resource';
import { decideUnlockRequest } from './functions/decide-unlock-request/resource';
import { zohoOauth } from './functions/zoho-oauth/resource';
import { zohoSync } from './functions/zoho-sync/resource';
import { replaceUser } from './functions/replace-user/resource';
import { invoiceOcr } from './functions/invoice-ocr/resource';

const backend = defineBackend({
  auth,
  data,
  storage,
  inviteUser,
  listAppUsers,
  manageUser,
  listTeamData,
  decideUnlockRequest,
  zohoOauth,
  zohoSync,
  replaceUser,
  invoiceOcr
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

// ---- manage-user: reset passwords, delete users, set-role (Super Admin only) ----
backend.manageUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.manageUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminDeleteUser',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:CreateGroup',
      // migrate-team-leads needs to enumerate the whole user pool.
      'cognito-idp:ListUsers'
    ],
    resources: [userPool.userPoolArn]
  })
);

// ---- list-team-data / decide-unlock-request: direct DynamoDB access ----
// These Lambdas filter rows by the caller's Cognito team group server-side,
// since Amplify Gen2 1.4's groupsDefinedIn('team') has a field-writability bug.
// Talk to the auto-generated DynamoDB tables directly using the SDK.
const projectTable = backend.data.resources.tables['Project'];
const clientTable = backend.data.resources.tables['Client'];
const exportLogTable = backend.data.resources.tables['ExportLog'];
const unlockTable = backend.data.resources.tables['UnlockRequest'];

backend.listTeamData.addEnvironment('PROJECT_TABLE_NAME', projectTable.tableName);
backend.listTeamData.addEnvironment('CLIENT_TABLE_NAME', clientTable.tableName);
backend.listTeamData.addEnvironment('EXPORTLOG_TABLE_NAME', exportLogTable.tableName);
backend.listTeamData.addEnvironment('UNLOCKREQUEST_TABLE_NAME', unlockTable.tableName);
backend.listTeamData.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.listTeamData.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:Scan', 'dynamodb:Query'],
    resources: [
      projectTable.tableArn, projectTable.tableArn + '/index/*',
      clientTable.tableArn, clientTable.tableArn + '/index/*',
      exportLogTable.tableArn, exportLogTable.tableArn + '/index/*',
      unlockTable.tableArn, unlockTable.tableArn + '/index/*'
    ]
  })
);
backend.listTeamData.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['cognito-idp:AdminGetUser'],
    resources: [userPool.userPoolArn]
  })
);

backend.decideUnlockRequest.addEnvironment('PROJECT_TABLE_NAME', projectTable.tableName);
backend.decideUnlockRequest.addEnvironment('UNLOCKREQUEST_TABLE_NAME', unlockTable.tableName);
backend.decideUnlockRequest.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [projectTable.tableArn, unlockTable.tableArn]
  })
);

// ---- zoho-oauth / zoho-sync: store and use Admin's Zoho refresh token ----
const zohoCredTable = backend.data.resources.tables['ZohoCredentials'];
backend.zohoOauth.addEnvironment('ZOHOCRED_TABLE_NAME', zohoCredTable.tableName);
backend.zohoOauth.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
    resources: [zohoCredTable.tableArn, zohoCredTable.tableArn + '/index/*']
  })
);
backend.zohoSync.addEnvironment('ZOHOCRED_TABLE_NAME', zohoCredTable.tableName);
backend.zohoSync.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [zohoCredTable.tableArn, zohoCredTable.tableArn + '/index/*']
  })
);

// ---- replace-user: Cognito admin actions + DDB table mutations ----
backend.replaceUser.addEnvironment('USER_POOL_ID', userPool.userPoolId);
backend.replaceUser.addEnvironment('CLIENT_TABLE_NAME', clientTable.tableName);
backend.replaceUser.addEnvironment('PROJECT_TABLE_NAME', projectTable.tableName);
backend.replaceUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminUpdateUserAttributes',
      'cognito-idp:AdminDeleteUser'
    ],
    resources: [userPool.userPoolArn]
  })
);
backend.replaceUser.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['dynamodb:Scan', 'dynamodb:UpdateItem'],
    resources: [
      clientTable.tableArn, clientTable.tableArn + '/index/*',
      projectTable.tableArn, projectTable.tableArn + '/index/*'
    ]
  })
);

// ---- invoice-ocr: AWS Textract AnalyzeExpense ----
// Single-page images/PDFs use the SYNCHRONOUS AnalyzeExpense with in-line
// bytes. Multi-page PDFs are not accepted by the sync API (it throws
// "Request has unsupported document format"), so those are routed through
// the ASYNCHRONOUS Expense API: the PDF is staged in S3, StartExpenseAnalysis
// kicks off the job, and we poll GetExpenseAnalysis until it completes. The
// Textract actions are resource-less, so "*" is the standard policy.
const ocrBucket = backend.storage.resources.bucket;
backend.invoiceOcr.addEnvironment('OCR_BUCKET', ocrBucket.bucketName);
backend.invoiceOcr.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'textract:AnalyzeExpense',
      'textract:StartExpenseAnalysis',
      'textract:GetExpenseAnalysis',
      // Raw-text pass to recover TRN / bill number / grand total that
      // AnalyzeExpense misses on UAE invoice layouts.
      'textract:DetectDocumentText',
      'textract:StartDocumentTextDetection',
      'textract:GetDocumentTextDetection'
    ],
    resources: ['*']
  })
);
// The async path stages the PDF under textract-temp/ and deletes it after the
// job finishes. Scope the Lambda's S3 rights to just that prefix.
backend.invoiceOcr.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
    resources: [ocrBucket.bucketArn + '/textract-temp/*']
  })
);
// Primary extractor: Claude (Sonnet 4.6) vision via Amazon Bedrock — reads
// photographed / dense multi-column invoices far better than Textract, and
// costs less than the AnalyzeExpense path. Textract remains the fallback.
// Claude on Bedrock is NOT in me-central-1, so we call a region that has it.
// NOTE: enable model access for the model below in the Bedrock console of that
// region (Bedrock → Model access) before this works.
backend.invoiceOcr.addEnvironment('BEDROCK_REGION', 'us-east-1');
backend.invoiceOcr.addEnvironment('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6-v1:0');
backend.invoiceOcr.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    // Cross-region inference profiles fan out to multiple regional model ARNs,
    // so "*" is the pragmatic scope for the Claude foundation models.
    resources: ['*']
  })
);
