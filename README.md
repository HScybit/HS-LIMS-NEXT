# Sampleify LIMS

Sampleify LIMS uses the Next.js App Router, React, PostgreSQL, Drizzle and the existing Bootstrap interface. Application code and configuration are JavaScript.

The current foundation provides database-backed sign-in, tenant-scoped sessions and permissions, profile edits, password changes, authenticator verification, logout and local password recovery. The authenticated entry currently opens My Account. Laboratory workflows, the module landing page, MFA enrollment, legacy credential import and external delivery adapters are still under development.

## Run locally

Requirements: Node **22.23.0**, npm, Docker Desktop and Google Chrome for browser tests.

```sh
nvm use
npm ci
npm run db:local
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://127.0.0.1:3000`. The synthetic username and generated password are saved in `.local/demo-credentials.txt`. The seed does not reset an existing account's password.

`db:local` creates the dedicated `sampleify-next-local-postgres` container and `sampleify-next-local-postgres18` volume using PostgreSQL 18.6 on **127.0.0.1:55442**. It generates private `.env.local` credentials. Repeating the command starts the same database without removing data. Existing unrelated resources are rejected. Stop this database with `docker stop sampleify-next-local-postgres` when it is no longer needed.

Password recovery uses a local capture adapter: messages are written to `.local/mail/` and never sent externally. Open the URL from the generated text file to complete a reset. The adapter only runs with a loopback application origin. External delivery and production configuration require a separate integration.

## Local verification

```sh
npm run lint
npm test
npm run test:integration
npm run build
npm run test:e2e
# Run the same checks together:
npm run verify
```

Browser tests launch the production build at `http://127.0.0.1:3100`, using installed Google Chrome and new synthetic accounts. Integration tests accept only the dedicated local database. Test data remains available for inspection; tests do not truncate or drop tables. Browser traces and reports are ignored by Git.

## Database changes

The canonical schema is in `src/db/schema.js`. Generate reviewed SQL with `npm run db:generate`, then apply it with `npm run db:migrate`. Custom SQL migrations hold row policies and restricted authentication functions. Applied migrations receive forward corrections, never edits. Drizzle's generated JSON files are schema-tool metadata on disk; no application database column uses JSON or JSONB.

`DATABASE_URL` must use the restricted `sampleify_app` login. `MIGRATION_DATABASE_URL` uses a separate schema owner; it is only needed by migration and synthetic seed commands. The local setup provisions these roles. An independently provisioned database needs those roles before migration. Never run the web application with schema-owner or superuser credentials.

Authentication functions resolve opaque session tokens before setting transaction-local tenant context. Tenant tables use row policies and composite foreign keys; domain services must also check permissions. Arbitrary SQL and caller-provided tenant context must never be exposed through application endpoints. Credentials and sessions have no direct runtime table grants.

Set `APP_ORIGIN` to the exact browser origin. Mutations require that origin and authenticated requests also require a session-bound CSRF token. Sessions expire after 12 hours, with at most five active sessions. Remember me preserves the source checkbox behavior without extending that duration. Passwords retain the source's eight-character minimum; password changes revoke other sessions, and resets revoke all sessions. The MFA encryption key must be 32 cryptographically random bytes encoded as hexadecimal and kept server-side.

Never commit `.env.local`, `.local/`, credentials, database dumps or browser traces. No GitHub Actions service is required.
