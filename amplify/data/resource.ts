import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';
import { listAppUsers } from '../functions/list-app-users/resource';
import { manageUser } from '../functions/manage-user/resource';
import { listTeamData } from '../functions/list-team-data/resource';
import { decideUnlockRequest } from '../functions/decide-unlock-request/resource';
/**
 * AppSync GraphQL schema for BCL AutoLedger.
 *
 * Note on team-scoped access: Amplify Gen2 1.4's `groupsDefinedIn('team')` rule
 * has a known bug — it auto-creates an internal `team` field that mutations
 * can't write to, and refuses to let the field be re-declared. So team-lead
 * visibility is implemented via a Lambda resolver (`listTeamData`) which runs
 * with elevated access, filters by the caller's team, and returns matching
 * rows. Same pattern for `decideUnlockRequest`, which unlocks a project on
 * behalf of an admin.
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
      allow.group('admin').to(['read', 'delete']),
    ]),

  /** A client/company the signed-in user works on. Owner + admin full access. */
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

  /**
   * Request from a non-admin user to unlock a locked project. Team Leads (the
   * "Admin" role in the UI) and Super Admins decide on these from their
   * dashboard — approving flips the matching Project.locked to false (handled
   * server-side by the decideUnlockRequest Lambda).
   */
  UnlockRequest: a
    .model({
      projectId: a.string().required(),
      projectName: a.string(),
      clientId: a.string(),
      clientName: a.string(),
      requestedByEmail: a.string(),
      requestedByName: a.string(),
      status: a.string().required(), // 'pending' | 'approved' | 'denied'
      requestedAt: a.datetime(),
      decidedByEmail: a.string(),
      decidedAt: a.datetime(),
      reason: a.string(),
      team: a.string()
    })
    .authorization((allow) => [
      allow.owner().to(['create', 'read']),
      allow.group('admin').to(['read', 'update', 'delete']),
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
    .handler(a.handler.function(manageUser)),

  /**
   * Returns rows visible to the caller based on their team. Admins (Cognito
   * 'admin' group) get everything; team-leads (Cognito 'team-<sub>' group) get
   * rows whose `team` field matches. Members get only their own rows.
   * `kind`: 'projects' | 'clients' | 'exportLogs' | 'unlockRequests'.
   * `clientId` is required for `kind = 'projects'`.
   */
  listTeamData: a
    .query()
    .arguments({
      kind: a.string().required(),
      clientId: a.string()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(listTeamData)),

  /**
   * Approve or deny an UnlockRequest. On approval, also flips the matching
   * Project's `locked` field to false. Caller must be a super-admin OR a
   * team-lead whose team matches the request's `team`.
   */
  decideUnlockRequest: a
    .mutation()
    .arguments({
      requestId: a.string(),
      projectId: a.string(),
      approve: a.boolean().required()
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(decideUnlockRequest))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
