# Sampleify LIMS

Sampleify LIMS uses the Next.js App Router, React, PostgreSQL, Drizzle and the existing Bootstrap interface. Application code and configuration are JavaScript.

The application provides database-backed sign-in, tenant-scoped sessions and permissions, profile edits, password changes, authenticator enrollment and verification, logout and local password recovery. Master Templates includes listing, creation, container/row/column editing, formulas, ordering, cloning and HTML preview. The authenticated entry opens My Account.

The template foundation supports text, input, paragraph, number, formula, checkbox, date, dropdown and template image widgets. Definitions and captured results use typed relational tables, stable field identities and frozen versions. Samples includes an initial registration form, quick customer creation, list/detail views and a sample's test-request queue. Analysts can be allocated to requests and enter results using autosave, repeated rows, Calculate and Done. Failed saves retain input, revision conflicts require reload, and runtime versions retain their original template and scientific specifications.

Test Parameters at `/test_parameters` includes the source list, form and detail view with laboratory search and measurement uncertainty. Its spreadsheet supports editable headers, rows, columns, keyboard shortcuts and formulas. Dedicated relational tables preserve raw cell text, stable row/column identities and immutable revisions. Edits retain the method, unit and scale settings outside this form; deletion retires the parameter while retaining existing references and history. Failed saves keep the draft, retries save once, and stale revisions require reload. Read-only master users can view the records.

Method of Analysis at `/method_of_analysis` includes the source list, form and details, with name, free-text UUID, description, decimal places, numeric conversion and multiple allowed users. New methods default to four decimal places and NO; explicit zero is retained. User searches are bounded, and selected names remain visible across searches. Edits preserve the internal code and existing parameter links. Immutable relational revisions retain the actual editor and ordered user selections. Deletion retires the method; failed and stale saves retain drafts, and retries do not create duplicate revisions.

Products at `/products` includes the source list, form and view with Name, Description, Abbreviation, Unique Key, Job Template and Tags. The visible key stays editable and unique within the organization. Template/tag searches are bounded, the list matches any selected tag, and selected labels survive lookup failures. Relational revisions preserve actual editors, ordered tags and hidden sample-category links. Deletion retires the product while retaining sample references and history. Interrupted saves/deletions can be retried without duplicate revisions; conflicting edits retain the local draft. Additional Data Fields supports the source text, number, date, date/time, select, checkbox, email, long-text, user, attachment and unconfigured lookup controls, including repeated values. Typed child rows retain raw zero/false/empty/invalid distinctions, definition revisions, option/user/file references and date-zone/parser provenance. Lost-response retries preserve the authored request even after a definition changes. Current field settings control list columns, filters and sorting; historical values remain tied to their saved definitions.

New sample registrations retain the selected Product's available immutable revision, including its saved Custom Fields. Later Product edits and retirement cannot retarget that reference. Existing sample lines and Products without recorded versions retain their captured name and key; missing historical versions are not inferred or backfilled.

Product-detail widgets display recorded Product attributes and Custom Fields in datasheets, report parameter rows and frozen final-result sections. Their Key selects `_id`, `name`, `description`, `key`, `abbr`, `job_template_id`, `tags`, `organization_id`, `user_id`, `created_at`, `updated_at`, or `project_field__splitter__<field key>`. Actual creation metadata is available only when a creation revision exists. Title, Required and Default Value remain designer configuration; the widget does not accept captured values or substitute its configured default for missing Product data. Reports pin their context line when generated, so later sample-line reordering cannot change the output. Whole legacy Product objects, additional legacy metadata and sample-template consumers remain incomplete.

Product context uses one bounded header query and up to three batched field/value queries, selecting only requested keys and the document's actual Product lines. The API shares prepared display strings between repeated widgets. It rejects more than 100 requested lines, 50,000 field headers, 500,000 raw items or 16 MiB of requested text. Missing bound history returns an error; an unknown field key renders empty. The PDF worker reads these projections only under its active lease for the report sample and receives no direct Product-history table grants.

Custom Fields at `/project_fields` includes the definition list, source form, detail view and deletion. It preserves the displayed field types, date formats, conditional controls, zero settings, case-sensitive dropdown option keys and ordered role selections. Field keys are lowercased and unique among active definitions in the organization. Three batched reads load a definition with up to 500 options and edit roles; immutable revisions preserve earlier settings and identities after edits or retirement. Interrupted saves/deletions can be retried, and failed or conflicting saves retain the draft. Definition authoring and Product capture/generation are implemented. Configurable lookup sources and other sample/master/widget integrations remain incomplete. Created At filters retain the source server's local-day parsing, so deployment must retain and verify the source server timezone.

The Custom Field attachment API accepts a single file of up to 20 MiB for a current Product attachment definition, including an empty file. It stores immutable bytes, filename, media type, checksum and the actual uploader/time with tenant and definition-version references. Exact upload retries retain the same identity; new uploads reject stale or retired definitions. Authenticated downloads remain available after definition edits, and active file types download under restrictive browser headers. The Product form supports upload, exact retry, view/download and clearing the draft reference without deleting historical bytes. Shared value helpers preserve source empty/zero/false and repeated-value behavior; Moment 2.30.1 handles browser-local formatting and server-only Moment Timezone 0.6.3 handles explicit named-zone parsing without changing global defaults. Product values persist in typed relational history; the new Product benchmark commands measure their full form/list/save path.

`GET /api/masters/products/custom-fields` loads current Product field definitions in source display order and their exact version's select options. It requires tenant master read/manage permission, returns at most 500 fields, and reports incomplete or oversized definitions without returning a partial form. Empty or text-only forms use one database statement; select options add one batched statement. An edit between reads cannot replace the selected revision's choices. Hidden nonselect options and definition role settings do not change this source form's controls. The Product form uses this endpoint before enabling Save. Field-load errors retain the base draft and offer Retry. Product history adds two batched captured-value reads; lists use at most six definition/page/value queries, independent of field and row count within the supported limits.

Datasheet submission records the exact frozen capture, selected final result, unit and actual analyst. Sample and test-request workflows support positive any/all/sequential approval with recorded comments and checklist answers. Done saves entered results; submission and approval are separate actions.

An assigned analyst can add applicable methods while the sample workflow permits testing. Each method has its own capture and frozen method/template version, retaining the request's frozen parameter, unit and acceptance criterion. The selected method supplies the submitted result and COA. Deleting an open method preserves its datasheet and history; the last active method and methods awaiting review cannot be deleted.

Organization Settings includes the job template, job workflow and automatic-generation choices. Tenant Settings also includes the source Date Format and Date-Time Format choices. Custom saved formats remain available; absent values display the source defaults. Older API clients preserve these preferences when saving other settings. Connecting these preferences to frozen TR Data output remains under implementation. TR Data configuration now includes Title, Key, Required and Default Value. These settings retain their template history; the configured title and default do not replace displayed request data. New captures and repeat clones do not store TR Data defaults, and Required does not demand an entered value for this read-only widget. Existing captured history is retained. Source Key-based runtime resolution is still being migrated. Jobs use the organization's summary template, falling back to each Product's Job Template when the organization choice is unset. Job execution requires an active datasheet template. Manual creation validates every selected product line and rolls back the selection if one is unavailable; automatic generation leaves unavailable groups unassigned. Later Product/settings edits cannot retarget an existing job. Manual jobs group selected requests by sample-product line; automatic jobs group newly generated requests and retain their original child assignments. Parameter-loop sections bind each row to its actual test request and frozen specification. Manual measurement clones preserve those bindings and can copy values. Source Financial Year and Non-NABL start-number controls use five explicit lexical settings columns. Product schemes preserve manual/on-init/on-submit timing, source token expansion, counter padding and ordered field dependencies. On Init runs during initial Save. Generation previews do not reserve counters; configured uniqueness protects actual saves. Native scheme patterns run in a separate worker with a ten-second command deadline; timed-out or invalid schemes return an error and retain the draft.

Numeric result inputs in a job summary retain their entry order, exact saved value and selected child datasheet. Submitting a job records each covered child result from its actual summary or individual capture, including zero and independently submitted results. Clears require correction before submission. Parent workflow completion or cancellation records its effect on the covered children, with the real parent action, actor and time. Child activity links to that job. After an intermediate parent decision, review continues through the job; stale actions from the child's previous graph are blocked. The child's original workflow definition and individual capture remain available as historical evidence.

**Test Reports** opens the COA template selection and saved-revision preview. Consolidated, product-wise and parameter-wise drafts pin submitted results, scientific specifications, report templates and print choices. Report widgets include sample details, test-request data, decision-rule fields, final results and serial numbers. Final-result sections retain repeated rows from the frozen capture. Generation retries reuse their request identity; explicit regeneration creates another immutable revision. Definition and capture reads batch across the report's templates and datasheets.

**Finalise** generates finalised reports and completes the sample in one transaction, retaining the actual actor, time and sample revision. A lost response can be retried without completing twice. Finalisation is separate from report issue and preserves the sample's workflow history. Later report generation retains earlier finalised revisions.

**Print** queues a durable PDF job and opens the browser print dialog when it is ready. A separate restricted worker renders the same frozen template/capture used by the preview. Each attempt retains its actual worker, timestamps and outcome; completed PDF bytes and checksums are immutable. Reopening or repeating Print uses the existing job and artifact for that report revision.

Header/footer management at `/header_management` and `/footer_management` uses the existing rich editor, image uploads, search and pagination. Saves retain immutable content and image versions; deletion preserves report history. Template Settings selects the existing NABL/non-NABL header and footer identities. Generated reports capture their exact content versions, so later edits cannot change earlier output. Report settings use separate read/manage permissions. The source Admin Hub navigation is still being migrated.

Template image widgets retain the source plan-mode chooser, key, width, margins and alignment controls. JPEG, PNG (including APNG), GIF and WebP previews retain the original image and its animation where present; printing uses an immutable first-frame PNG with its recorded orientation. Replacements advance the editable draft, with exact upload retries and typed references preserved by runtime snapshots, captures and report history. Image uploads are limited to 10 MiB, 10,000 pixels per side, 200 frames and 40 megapixels across frames. Original and print bytes share the 24 MiB asset batch and 32 MiB expanded rendering budgets.

Watermark management at `/watermark_report` retains the source list, image preview, opacity slider, dimensions and rotation control. Typed revisions preserve zero opacity, prior image/settings values and actual editors after replacement or deletion. Concurrent edits require the current revision, and interrupted response retries save once. This management screen does not automatically apply a watermark to COAs; the inspected source report callers have no active watermark selection.

This is an initial working flow. Accreditation/ULR handling and report issue remain under development. Full sample editing and variants, additional report asset formats and fonts, allocation resources and qualification checks, remaining widgets, spreadsheet result modes, intermediate job/child workflow synchronization, full rich-text/access/print settings and migration adapters are also incomplete. NABL grouping, rejection timing and conflicting scientific error/numeric-prefix policies remain unresolved; affected actions do not silently choose a different interpretation.

Checklists at `/checklists` includes the source list, form, detail view and deletion, with name search, active-status filtering and up to 200 ordered line items. New forms start inactive; inactive checklists can be edited and reactivated. Stable item identities and immutable relational revisions preserve actual edits, while deletion retains history. Failed saves and deletions keep their retry identity; stale saves keep the draft for explicit reload. `checklists.read` permits viewing and `checklists.manage` permits editing.

Workflow authoring can select an active checklist master and copy its ordered prompts as required checks, recording the master revision when known. Explicit selection refreshes the copy; omitting the binding preserves it, and explicit null detaches it. Published workflows, both clone commands and actual approval answers retain their saved prompts through later master edits or deactivation. Referenced checklists cannot be deleted. Bounded choices at `/api/workflows/checklists` require workflow read/manage access without exposing Checklist Master contents. The complete workflow canvas remains under implementation.

Workflow definitions also preserve the four source Auto Move choices: `yes`, `no`, `all_trs_allocated` and `all_trs_approved`. Historical modes remain unknown when only an older boolean was recorded. Explicit mode changes derive the matching boolean, while older clients retain unchanged conditional choices. Automatic progression and the remaining editor interactions are still under implementation.

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

`db:seed:lab` adds a synthetic water category, product, customer/address, parameter, method, acceptance criterion, analytical template and initial workflows to the demonstration laboratory. It enables the demonstration administrator's registration, allocation and test-parameter management permissions and reuses the same fixture on subsequent runs. It is restricted to the dedicated local database and the known demonstration account. In Samples, create a sample using these choices and **Auto-fill parameters**, then use **More actions → Generate Test Requests**, **Allocate**, **View → Add Results**. The fixture demonstrates data entry and persistence; it does not issue an approved scientific report.

`db:local` creates the dedicated `sampleify-next-local-postgres` container and `sampleify-next-local-postgres18` volume using PostgreSQL 18.6 on **127.0.0.1:55442**. It generates private `.env.local` credentials. Repeating the command starts the same database without removing data. Existing unrelated resources are rejected. Stop this database with `docker stop sampleify-next-local-postgres` when it is no longer needed.

Run `npm run worker:reports` in a separate terminal for PDF printing. `worker:setup` provisions `sampleify_report_worker` before migrations and saves its private connection in `.env.worker.local`. The worker has no application/owner role membership and cannot write analytical records. Supply only `WORKER_DATABASE_URL` to the worker in a managed environment; never supply schema-owner credentials to a web or worker process.

`npm run build` also builds the report renderer. During development, rebuild it and restart the worker after template-rendering, PDF, style or dependency changes. Private renderer artifacts live under `.local/report-renderers/`; their identifier hashes the bundled rendering code, stylesheet and dependency lock. A worker processes only its matching release. Drain old queued jobs with the matching worker/dependencies before retiring a release; retain generated PDF artifacts and database backups. Deploy the renderer artifacts alongside the web and worker release. Without a worker, jobs remain queued; closing the browser does not cancel them. Transient failures retry with delays up to five attempts. A terminal failure requires correcting its cause and explicitly regenerating the report to create a new revision.

PDF rendering uses installed Google Chrome, permits only captured inline resources and has a 30-second rendering limit and 50 MiB output limit. Static PNG/JPEG/WebP/SVG uploads are decoded and limited to 10 MiB, 10,000 pixels per side and 40 megapixels. SVG retains its original vector bytes; its static profile supports shapes, text, gradients, styles and local references, with limits of 20,000 nodes/expanded references and 100 nesting levels. Executable markup, foreign content, animation, external resources, XML document types, CSS escapes/comments and unsupported effects are rejected. SVG is revalidated on image and report reads. A render batch permits 24 MiB of distinct image bytes and 32 MiB of expanded content. Header/footer heights use the selected paper width and orientation; margins retain the source CSS-pixel units. Chrome's additional page-header padding is removed so it cannot overlap the report body. The renderer loads captured assets in one batched read, in addition to the eight core definition reads and up to three capture reads. It does not fetch image URLs from the network. Report HTML/render models exist only in memory; authored rich content is retained in immutable content versions alongside typed image references. CKEditor assets and their license are retained under `public/ckeditor`.

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

`test:migrations` creates a fresh synthetic database in the same local PostgreSQL container, applies the full migration chain twice, and checks authentication, MFA enrollment/retry/disable, template capture, parameter uncertainty and method/user history and retirement, Product Custom Field capture/generation/listing, customer creation, sample registration, allocation and grouped result approval using the restricted application role. The restricted worker produces PDFs for individual final sections with captured Product widgets and for grouped results. The command retains that database and records its name in `.local/migration-verification.json`; it never resets an existing database.

## Database changes

The canonical schema is in `src/db/`: identity, template, master, workflow, sample and report schema files. Generate reviewed SQL with `npm run db:generate`, then apply it with `npm run db:migrate`. Custom SQL migrations hold row policies, immutable-version guards and restricted functions. Applied migrations receive forward corrections, never edits. Drizzle's generated JSON files are schema-tool metadata on disk; no application database column uses JSON or JSONB.

`DATABASE_URL` must use the restricted `sampleify_app` login. `MIGRATION_DATABASE_URL` uses a separate schema owner; it is only needed by migration and synthetic seed commands. The local setup provisions these roles. An independently provisioned database needs those roles before migration. Never run the web application with schema-owner or superuser credentials.

Authentication functions resolve opaque session tokens before setting transaction-local tenant context. Tenant tables use row policies and composite foreign keys; domain services must also check permissions. Arbitrary SQL and caller-provided tenant context must never be exposed through application endpoints. Credentials and sessions have no direct runtime table grants.

Template loads use eight fixed data queries including version selection; capture history adds three. Datasheet loads add one metadata query, plus one batched context query when data widgets need it. Image widgets add one batched asset query; reports share that query with their captured headers, footers and stylesheet assets. Exact historical job selections share the third capture query. Authentication, transaction setup and write authorization are counted separately. HTTP models omit repeated scope metadata and duplicate expression encodings. These objects are derived transport, with no separately persisted document or render cache. Database statements time out after 30 seconds and failed transactions roll back.

Capture reads select revision keys from the history index before fetching typed value payloads. Occurrences are filtered at each requested capture revision before the 200,000-value batch limit, so removed rows do not consume that limit. Explicit historical job selections still retrieve their recorded values after a row is removed.

New capture revisions have immutable records of their full PostgreSQL transaction ID, actor, database role, time and status. Runtime value and repeat changes must belong to the transaction that created their revision; captured values also require the real save actor and time. This prevents later writes from changing a committed revision. Captures created before this boundary retain their original evidence, with revision records beginning at their next actual change.

Set `APP_ORIGIN` to the exact browser origin. Mutations require that origin and authenticated requests also require a session-bound CSRF token. Sessions expire after 12 hours, with at most five active sessions. Remember me preserves the source checkbox behavior without extending that duration. Passwords retain the source's eight-character minimum; password changes revoke other sessions, and resets revoke all sessions. The MFA encryption key must be 32 cryptographically random bytes encoded as hexadecimal and kept server-side.

My Account supports the source MFA switch, local QR code and setup key, authenticator verification, and disable confirmation. Setup expires after ten minutes (or the session expiry if sooner), is encrypted at rest and belongs to the session that created it. Password changes invalidate pending setup. Failed verification is limited to five attempts per account in fifteen minutes, including concurrent requests and setup restarts. A successful enrollment consumes its TOTP step; use the next code when signing in again. Setup/change identities and revisions protect retries and stale dialogs. Disabling removes the stored factor secret. Existing signed-in sessions remain active when MFA changes, matching the source behavior. QR and setup responses are not cached; QR generation uses the local `qrcode` package and no external service.

## Template performance checks

```sh
npm run benchmark:templates
PROFILE_REACT=1 npm run build
npm run benchmark:browser
# Runtime API and expanded datasheet browser measurements:
npm run benchmark:datasheets
npm run benchmark:datasheet-browser
# Product Custom Field service, list, generation and form measurements:
npm run benchmark:product-fields
npm run benchmark:product-fields-browser
# Recorded Product projections and allocated datasheet consumers:
npm run benchmark:product-context
npm run benchmark:product-context-browser
# Restore the ordinary production build afterward:
npm run build
```

The server benchmark creates synthetic small, large and nested templates in the isolated local database. It records 30 read/save/freeze runs and 1/5/20-session read loads, including SQL, assembly, serialization, formula timing and payload size. `npm run benchmark:templates -- --reuse` measures the previously generated fixture identities again and retains the prior report; this requires that the fixture templates have no unfinished drafts. Run without `--reuse` to generate fresh fixtures after a browser benchmark, which leaves edited drafts for inspection.

Each browser benchmark requires its completed server fixture report and a profiling build. It measures 30 loads locally and with 4× CPU throttling, 150 ms network latency and limited bandwidth, plus saves. Runtime measurements also separate input response and React commits from API loading, parsing and initialization. Run benchmarks without concurrent builds or tests. Reports stay in `.local/`; these synthetic measurements do not establish source-application or production performance.

The runtime server report includes individual statement timings and app-role query plans captured immediately after warm and concurrent reads. Plans run outside timed samples, before the next fixture changes database statistics. Individual statement timings include client and transfer overhead; query plans record database execution time separately.

Never commit `.env.local`, `.env.worker.local`, `.local/`, credentials, database dumps or browser traces. No GitHub Actions service is required.
