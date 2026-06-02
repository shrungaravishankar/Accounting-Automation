import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';
import { listAppUsers } from '../functions/list-app-users/resource';
import { manageUser } from '../functions/manage-user/resource';

/**
 * AppSync GraphQL schema for BCL AutoLedger.
 * The AppHealth model is a placeholder so AppSync has a valid Query type.
 */
const schema = a.schema({
  AppHealth: a
    .model({
      status: a.string()
    })
    .authorization((allow) => [allow.authenticated()]),

  /**
   * One row per exported file. The owner (creator) can read their own history;
   * the `admin` group can read everything. The actual file lives in S3 at
   * `storagePath`; this is the searchable log/metadata.
   */
  ExportLog: a
    .model({
      userName: a.string(),
      userEmail: a.string(),
      kind: a.string(),                  // "journal" | "expenses" | "revenue" | "bsItems" | "suspense" | "bills" | "export"
      filename: a.string().required(),
      sizeBytes: a.integer(),
      storagePath: a.string().required(), // S3 key including identity prefix
      client: a.string(),
      clientId: a.string(),
      transactionsCount: a.integer(),
      expensesCount: a.integer(),
      journalsCount: a.integer(),
      bsItemsCount: a.integer(),
      revenueCount: a.integer(),
      suspenseCount: a.integer(),
      dateFrom: a.string(),
      dateTo: a.string(),
      sourceBank: a.string(),
      sourceCoa: a.string(),
      sourceVendors: a.string(),
      sourceCustomers: a.string(),
      generatedAt: a.datetime(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read']),
      allow.group('admin').to(['read', 'delete'])
    ]),

  /** A client/company the signed-in user works on. Owner + team-lead full access. */
  Client: a
    .model({
      name: a.string().required(),
      // Captured at creation so Team Leads / Admin can see who created what.
      ownerEmail: a.string(),
      ownerName: a.string(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read', 'update', 'delete']),
      allow.group('admin').to(['create', 'read', 'update', 'delete']),
    ]),

  /**
   * A saved project (one processed bank statement) for re-download. Metadata
   * lives here; the heavy payload (transactions + journal entries) is a JSON
   * file in S3 at `dataPath`.
   */
  Project: a
    .model({
      clientId: a.string().required(),
      clientName: a.string(),
      name: a.string().required(),
      exportedAt: a.datetime(),
      bankName: a.string(),
      period: a.string(),
      txnCount: a.integer(),
      expenseCount: a.integer(),
      journalCount: a.integer(),
      bsCount: a.integer(),
      prCount: a.integer(),
      suspenseCount: a.integer(),
      dataPath: a.string().required(),
      // Captured at creation so Managers/Team Leads can see who exported what.
      ownerEmail: a.string(),
      ownerName: a.string(),
      // When true the project is read-only — reopen / rename / delete are blocked.
      locked: a.boolean(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read', 'update', 'delete']),
      allow.group('admin').to(['create', 'read', 'update', 'delete']),
    ]),

  InviteResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required()
  }),

  ManageResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required(),
    tempPassword: a.string()
  }),

  inviteUser: a
    .mutation()
    .arguments({
      email: a.string().required(),
      fullName: a.string().required(),
      role: a.string().required()
    })
    .returns(a.ref('InviteResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(inviteUser)),

  listAppUsers: a
    .query()
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(listAppUsers)),

  manageUser: a
    .mutation()
    .arguments({
      email: a.string().required(),
      action: a.string().required(),
      role: a.string()
    })
    .returns(a.ref('ManageResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(manageUser))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
