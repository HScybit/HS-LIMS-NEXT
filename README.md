# Sampleify LIMS

Sampleify LIMS uses the Next.js App Router, React, PostgreSQL, Drizzle and the existing Bootstrap interface. Application code and configuration are JavaScript.

The application provides database-backed sign-in, tenant-scoped sessions and permissions, profile edits, password changes, authenticator verification, logout and local password recovery. Master Templates includes listing, creation, container/row/column editing, formulas, ordering, cloning and HTML preview. The authenticated entry opens My Account.

The template foundation supports text, input, paragraph, number, formula, checkbox, date and dropdown widgets. Definitions and captured results use typed relational tables, stable field identities and frozen versions. Samples includes an initial registration form, quick customer creation, list/detail views and a sample's test-request queue. Analysts can be allocated to requests and enter results using autosave, repeated rows, Calculate and Done. Failed saves retain input, revision conflicts require reload, and runtime versions retain their original template and scientific specifications.

Datasheet submission records the exact frozen capture, selected final result, unit and actual analyst. Sample and test-request workflows support positive any/all/sequential approval with recorded comments and checklist answers. Done saves entered results; submission and approval are separate actions.

An assigned analyst can add applicable methods while the sample workflow permits testing. Each method has its own capture and frozen method/template version, retaining the request's frozen parameter, unit and acceptance criterion. The selected method supplies the submitted result and COA. Deleting an open method preserves its datasheet and history; the last active method and methods awaiting review cannot be deleted.

**Test Reports** opens the COA template selection and saved-revision preview. Consolidated, product-wise and parameter-wise drafts pin submitted results, scientific specifications, report templates and print choices. Report widgets include sample details, test-request data, decision-rule fields, final results and serial numbers. Final-result sections retain repeated rows from the frozen capture. Generation retries reuse their request identity; explicit regeneration creates another immutable revision. Definition and capture reads batch across the report's templates and datasheets.

**Print** queues a durable PDF job and opens the browser print dialog when it is ready. A separate restricted worker renders the same frozen template/capture used by the preview. Each attempt retains its actual worker, timestamps and outcome; completed PDF bytes and checksums are immutable. Reopening or repeating Print uses the existing job and artifact for that report revision.

This is an initial working flow. Report finalisation and accreditation/ULR handling remain under development. Full sample editing and variants, captured report assets, allocation resources and qualification checks, remaining widgets, rich text, full access/print settings, MFA enrollment and migration adapters are also incomplete. Rejection timing and conflicting scientific error/numeric-prefix policies remain unresolved; affected actions do not silently choose a different interpretation.

## Run locally

Requirements: Node **22.23.0**, npm, Docker Desktop and Google Chrome for browser tests.

```sh
nvm use
npm ci
npm run db:local
npm run worker:setup
npm run db:migrate
npm run db:seed
npm run db:seed:lab
npm run build:report-renderer
npm run dev
```

Open `http://127.0.0.1:3000`. The synthetic username and generated password are saved in `.local/demo-credentials.txt`. The seed does not reset an existing account's password.

`db:seed:lab` adds a synthetic water category, product, customer/address, parameter, method, acceptance criterion, analytical template and initial workflows to the demonstration laboratory. It enables the demonstration administrator's registration/allocation permissions and reuses the same fixture on subsequent runs. It is restricted to the dedicated local database and the known demonstration account. In Samples, create a sample using these choices and **Auto-fill parameters**, then use **More actions → Generate Test Requests**, **Allocate**, **View → Add Results**. The fixture demonstrates data entry and persistence; it does not issue an approved scientific report.

`db:local` creates the dedicated `sampleify-next-local-postgres` container and `sampleify-next-local-postgres18` volume using PostgreSQL 18.6 on **127.0.0.1:55442**. It generates private `.env.local` credentials. Repeating the command starts the same database without removing data. Existing unrelated resources are rejected. Stop this database with `docker stop sampleify-next-local-postgres` when it is no longer needed.

Run `npm run worker:reports` in a separate terminal for PDF printing. `worker:setup` provisions `sampleify_report_worker` before migrations and saves its private connection in `.env.worker.local`. The worker has no application/owner role membership and cannot write analytical records. Supply only `WORKER_DATABASE_URL` to the worker in a managed environment; never supply schema-owner credentials to a web or worker process.

`npm run build` also builds the report renderer. During development, rebuild it and restart the worker after template-rendering, PDF, style or dependency changes. Private renderer artifacts live under `.local/report-renderers/`; their identifier hashes the bundled rendering code, stylesheet and dependency lock. A worker processes only its matching release. Drain old queued jobs with the matching worker/dependencies before retiring a release; retain generated PDF artifacts and database backups. Deploy the renderer artifacts alongside the web and worker release. Without a worker, jobs remain queued; closing the browser does not cancel them. Transient failures retry with delays up to five attempts. A terminal failure requires correcting its cause and explicitly regenerating the report to create a new revision.

PDF rendering uses installed Google Chrome, permits only captured inline resources and has a 30-second rendering limit and 50 MiB output limit. It does not fetch report images from the network. Header/footer heights and margins retain the source CSS-pixel units. Uncaptured assets prevent printing until the asset adapter is completed. The HTML and render model exist only in memory; the database stores typed job/attempt metadata and generated PDF bytes.

Password recovery uses a local capture adapter: messages are written to `.local/mail/` and never sent externally. Open the URL from the generated text file to complete a reset. The adapter only runs with a loopback application origin. External delivery and production configuration require a separate integration.

## Local verification

```sh
npm run lint
npm test
npm run build:report-renderer
npm run test:integration
npm run test:migrations
npm run build
npm run test:e2e
# Run lint, unit, integration, build and browser checks together:
npm run verify
```

Browser tests launch the production build at `http://127.0.0.1:3100`, using installed Google Chrome and new synthetic accounts. The Print test starts a separate worker, verifies the actual PDF blob and checksum, and observes the native print call without opening a headless print dialog. Native dialog/print-layout checks use visible Chrome separately. Integration tests accept only the dedicated local database. Test data remains available for inspection; tests do not truncate or drop tables. Browser traces and reports are ignored by Git.

`test:migrations` creates a fresh synthetic database in the same local PostgreSQL container, applies the full migration chain twice, and checks authentication, template capture, customer creation, sample registration and allocation using the restricted application role. It retains that database and records its name in `.local/migration-verification.json`; it never resets an existing database.

## Database changes

The canonical schema is in `src/db/`: identity, template, master, workflow, sample and report schema files. Generate reviewed SQL with `npm run db:generate`, then apply it with `npm run db:migrate`. Custom SQL migrations hold row policies, immutable-version guards and restricted functions. Applied migrations receive forward corrections, never edits. Drizzle's generated JSON files are schema-tool metadata on disk; no application database column uses JSON or JSONB.

`DATABASE_URL` must use the restricted `sampleify_app` login. `MIGRATION_DATABASE_URL` uses a separate schema owner; it is only needed by migration and synthetic seed commands. The local setup provisions these roles. An independently provisioned database needs those roles before migration. Never run the web application with schema-owner or superuser credentials.

Authentication functions resolve opaque session tokens before setting transaction-local tenant context. Tenant tables use row policies and composite foreign keys; domain services must also check permissions. Arbitrary SQL and caller-provided tenant context must never be exposed through application endpoints. Credentials and sessions have no direct runtime table grants.

Template loads use eight fixed data queries including version selection; capture history adds three. Datasheet loads add one metadata query; authentication, transaction setup and write authorization are counted separately. HTTP models omit repeated scope metadata and duplicate expression encodings. These objects are derived transport, with no separately persisted document or render cache. Database statements time out after 30 seconds and failed transactions roll back.

Set `APP_ORIGIN` to the exact browser origin. Mutations require that origin and authenticated requests also require a session-bound CSRF token. Sessions expire after 12 hours, with at most five active sessions. Remember me preserves the source checkbox behavior without extending that duration. Passwords retain the source's eight-character minimum; password changes revoke other sessions, and resets revoke all sessions. The MFA encryption key must be 32 cryptographically random bytes encoded as hexadecimal and kept server-side.

## Template performance checks

```sh
npm run benchmark:templates
PROFILE_REACT=1 npm run build
npm run benchmark:browser
# Runtime API and expanded datasheet browser measurements:
npm run benchmark:datasheets
npm run benchmark:datasheet-browser
# Restore the ordinary production build afterward:
npm run build
```

The server benchmark creates synthetic small, large and nested templates in the isolated local database. It records 30 read/save/freeze runs and 1/5/20-session read loads, including SQL, assembly, serialization, formula timing and payload size. `npm run benchmark:templates -- --reuse` measures the previously generated fixture identities again and retains the prior report; this requires that the fixture templates have no unfinished drafts. Run without `--reuse` to generate fresh fixtures after a browser benchmark, which leaves edited drafts for inspection.

Each browser benchmark requires its completed server fixture report and a profiling build. It measures 30 loads locally and with 4× CPU throttling, 150 ms network latency and limited bandwidth, plus saves. Runtime measurements also separate input response and React commits from API loading, parsing and initialization. Run benchmarks without concurrent builds or tests. Reports stay in `.local/`; these synthetic measurements do not establish source-application or production performance.

Never commit `.env.local`, `.env.worker.local`, `.local/`, credentials, database dumps or browser traces. No GitHub Actions service is required.
