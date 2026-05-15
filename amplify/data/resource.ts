import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { inviteUser } from '../functions/invite-user/resource';

/**
 * AppSync GraphQL schema for BCL AutoLedger.
 *
 * AppSync requires at least one Query field in the schema, but our app
 * only needs the inviteUser mutation. The AppHealth model exists solely
 * to satisfy that AppSync requirement — it creates a small DynamoDB
 * table that the app never touches.
 */
const schema = a.schema({
  // Placeholder model — required because AppSync needs at least one Query.
  // We never read from or write to this table.
  AppHealth: a.model({
    status: a.string()
  }).authorization((allow) => [allow.authenticated()]),

  InviteResult: a.customType({
    success: a.boolean().required(),
    message: a.string().required()
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
    .handler(a.handler.function(inviteUser))
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool'
  }
});
