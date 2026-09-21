# Backend — API + Query Engine

Express API in front of a generic, metadata-driven query engine, on PostgreSQL. Nothing in
`src/query` knows anything about a particular dashboard: table names, columns, measures,
dimensions, filters, aggregations and date grains all arrive from dashboard JSON and are
validated against the live catalogue before reaching SQL.

## Layout

```
backend/
├── src/
│   ├── server.js                    entry point: express app, static files, listen
│   │
│   ├── api/
│   │   └── response.js              the success/error envelope, codes, id validation
│   │
│   ├── middleware/
│   │   ├── requestTimer.js
│   │   ├── auth.js                  requireAuth / requirePermission / requireDashboardAccess
│   │   └── session.js               session cookies and the CSRF double-submit check
│   │
│   ├── routes/
│   │   ├── index.js                 everything under /api, the 404, the error handler
│   │   ├── dashboardRoutes.js       read a dashboard, replace one card
│   │   ├── metadataRoutes.js        column catalogue + card preview
│   │   ├── authRoutes.js            login, refresh, logout, /me, activation, password
│   │   ├── companyRoutes.js         companies and their dashboard assignments
│   │   ├── userRoutes.js            user administration + data scopes
│   │   ├── roleRoutes.js            the three roles and their permissions
│   │   ├── groupRoutes.js           groups and their membership
│   │   └── accessRoutes.js          dashboard grants
│   │
│   ├── auth/                        RBAC — see "Access control" below
│   │   ├── appMetaSchema.js         idempotent bootstrap of the metadata database
│   │   ├── permissionCatalogue.js   roles, role scopes, permissions, access levels
│   │   ├── authorization.js         the one allow/deny layer: can / assert / scope
│   │   ├── companyService.js        companies — the tenant boundary
│   │   ├── userService.js           users, roles, password hashing
│   │   ├── groupService.js          groups and company-scoped membership
│   │   ├── accessService.js         who may open which dashboard, at what level
│   │   ├── tokenService.js          access tokens, refresh rotation and revocation
│   │   ├── activationService.js     single-use onboarding links
│   │   ├── onboardingService.js     one invitation, shared by every path that sends one
│   │   ├── loginThrottle.js         per-identifier sign-in rate limiting
│   │   ├── scopeService.js          row-level data scopes (stored, not yet applied)
│   │   └── auditService.js          append-only audit trail
│   │
│   ├── email/                       provider-agnostic mail
│   │   ├── emailService.js          the only way the application sends mail
│   │   ├── templates.js             message content, independent of transport
│   │   └── providers/smtpProvider.js
│   │
│   ├── config/
│   │   ├── env.js                   loads .env once, resolves directory roots
│   │   ├── configError.js           required/optional readers that fail loudly
│   │   ├── pgPool.js                the driver, `?` placeholders, type coercions
│   │   ├── database.js              the one PostgreSQL pool, plus the RBAC table names
│   │   ├── appConfig.js             fixed in source: TTLs, throttling, bootstrap owner
│   │   ├── auth.js                  tokens, cookies, password policy
│   │   └── email.js                 the SMTP relay, read from the environment
│   │
│   ├── dashboard/
│   │   ├── cardModel.js             card shape: chartType -> kpi|chart, spec migration
│   │   ├── dashboardRegistry.js     dashboardId -> dashboard JSON (file-backed)
│   │   └── dashboardService.js      hydrates a spec into the API response shape
│   │
│   └── query/                       the engine — one file per pipeline stage
│       ├── queryEngine.js           orchestrator (plan -> optimize -> SQL -> run -> format)
│       ├── semanticLayer.js         SQL vocabulary: aggregations, operators, date
│       │                            grains, identifier quoting, predicates
│       ├── metadataResolver.js      INFORMATION_SCHEMA discovery + validation
│       ├── schemaCache.js           5-minute schema cache
│       ├── queryPlanner.js          spec -> validated plans (measures, dimensions,
│       │                            date groups, sort terms, filters)
│       ├── queryOptimizer.js        merges compatible KPI queries
│       ├── sqlGenerator.js          plans -> parameterised SQL
│       ├── queryExecutor.js         runs SQL, times it, logs failures
│       ├── resultFormatter.js       rows -> the frontend contract
│       └── queryCache.js            Redis + in-memory query cache
│
├── config/dashboards/               runtime dashboard metadata (not source)
│   └── default.json
├── config/rbac/                     runtime RBAC configuration
│   └── scope-dimensions.json        columns a data scope may be assigned on
│
├── logs/audit.log                   append-only audit trail (gitignored)
│
├── scripts/setupIndexes.js          creates indexes for slicer/groupBy columns
├── scripts/resetAccess.js           emails an account a fresh activation link
│
├── tests/rbac.e2e.js                the RBAC / tenancy / token / onboarding suite
├── tests/smtpSink.js                an in-process SMTP relay the suite reads mail from
└── tests/reportingFixture.js        a small source table so dashboard checks are real
```

## Request flow

```
GET /api/dashboard/<id>
  middleware/auth                  verify access token -> resolve the actor
                                   requirePermission('dashboard.read')
                                   requireDashboardAccess('view')  <- before any SQL
  dashboard/dashboardRegistry.js   dashboardId -> dashboard JSON
  dashboard/dashboardService.js    hydrateView
  query/queryEngine.js             hydrateDashboard
    query/metadataResolver         resolve + validate table and columns
    query/queryPlanner             one isolated plan per card / slicer
    query/queryOptimizer           merge compatible KPI queries
    query/sqlGenerator             parameterised SQL
    query/queryCache               keyed on SQL + bound params
    query/queryExecutor            PostgreSQL, bounded concurrency
    query/resultFormatter          rows -> cards / slicers
  JSON response
```

Authorization runs to completion before the registry is touched. Authorization that runs
after the engine has already queried the database is not a boundary, it is a filter on the way out.

Each card and slicer is planned, executed and formatted independently: one invalid
visual returns `error` metadata for itself while the rest of the dashboard still renders.
Filter resolution is the one request-level failure, because a silently unapplied filter
would misstate every visual.

## Cards

A dashboard declares one ordered `cards` list. `dashboard/cardModel.js` reads each card's
`chartType` to decide whether it is planned as a KPI badge (`planKpi` — one aggregated
value, optionally compared across a date grain) or as a chart (`planCard`). Nothing else
distinguishes them, so the same JSON keys mean the same thing on every card and the
editor offers every option for every card.

Older dashboard files that declare a separate `kpis` array, or nest a card's fields under
`series.main`, are normalised into this shape when the registry reads them — so they keep
working, and are rewritten flat the first time a card is saved.

## Adding a dashboard

Drop a JSON file into `config/dashboards/<id>.json`. Ids are restricted to
`[A-Za-z0-9_-]{1,64}`, which is also the path-traversal guard. No engine code changes.

A dashboard file existing is not the same as anybody being able to open it: assign it to a
company (`PUT /api/companies/:id/dashboards/:dashboardId`), then grant it to users or groups
inside that company.

A spec's `dataSource` names a `table` and, optionally, a `schema` (default `DB_SCHEMA`).
It may also carry `database`, but only as an assertion: PostgreSQL cannot query across
databases, so a value that is not the connected `DB_NAME` is an error rather than a
silently wrong answer.

String date columns declare a `to_date` template:

```json
"dataSource": { "schema": "public", "table": "cinema_analysis",
                "dateParse": { "Booking Date": "DD-Mon-YY" } }
```

A leftover `%`-style pattern is rejected with a message rather than passed through -
`to_date(col, '%d-%b-%y')` does not fail, it matches the literal characters and returns a
nonsense date, which would bucket every row into the wrong period.

The two editor endpoints take the dashboard id, so an editor opened on one dashboard
catalogues that dashboard's own source table:

```
GET  /api/dashboard/columns?dashboardId=<id>
POST /api/dashboard/preview      { "dashboardId": "<id>", "card": { ... } }
```

The id is **required** on both. It used to be optional and fall back to the default
dashboard, which cannot mean anything now that dashboards belong to companies.

## Access control

RBAC lives in `src/auth`, is enforced by `src/middleware/auth.js`, and stores its data in
the **same database as the reporting tables** — one `DB_NAME`, one pool, created
automatically on first start.

That is a deliberate simplification of an earlier arrangement that kept the metadata in a
second database with its own credentials, where a connection literally could not reach the
auth tables. That guarantee is gone: anything holding these credentials can read `users`
and `refresh_tokens`. What remains is that password hashes are bcrypt, and refresh and
activation tokens are stored as HMACs keyed with a secret that lives outside the database —
so a dump of these tables still cannot be replayed on its own. Give the reporting data its
own `DB_SCHEMA` if either set of tables might want a name like `users`.

### Three roles, two of them inside a company

```
SUPER_ADMIN            platform owner: every company, user, role and assignment
   |
   +-- COMPANY_ADMIN   one company: its users, groups and access
          |
          +-- USER     one company: only what has been granted to them
```

A role's **scope** — `platform` or `company` — is a column on the role row, and it is what
authorization reads. Nothing in the codebase compares a role *name* to decide what somebody
may do, so adding a capability is a permission id plus a guard, not an audit of thirty
`if (role === ...)` branches.

### Three independent axes

| | Granted through | Answers |
|---|---|---|
| **Role scope** | the role row | may this request leave its company at all? |
| **Permission** | the user's role | may this user *do* this kind of thing? |
| **Access level** | a grant on the user or a **group** | what may they do with *one dashboard*? |

Permissions are business capabilities (`user.create`, `access.grant`, `dashboard.read`, …)
listed in `src/auth/permissionCatalogue.js` — that file is the whole vocabulary, and a
permission missing from it cannot be granted. Access levels are ranked `view < share <
developer < admin`; a user's effective level is the **strongest** of their direct grant and
the grants of every *active* group they belong to, in their own company.

`PLATFORM_ONLY_PERMISSIONS` can never be given to a company role — those are the
capabilities that would let a customer's administrator act outside their own company.

### Tenant isolation

Two gates stand between a user and a dashboard, and both are checked server-side:

1. **`company_dashboards`** — which dashboards a company may use at all. Only
   `dashboard.assign` (platform-only) writes it.
2. **A grant** — direct on the user, or through an active group of their own company.

A company administrator can only grant what gate 1 already allows, so no sequence of
company-level actions reaches another customer's dashboard. Every read that can return
somebody else's row filters by company **in SQL** (`authorization.companyScope`), and a
resource in another company answers `404`, not `403` — telling them apart would turn
`/api/users/:id` into a way to count a competitor's accounts.

A `companyId` in a request body is **ignored** for a company-scoped caller rather than
validated: the only correct value is one the client cannot influence.

### Dashboards are still files

There is no `dashboards` table. `dashboard/dashboardRegistry.js` remains the only source of
truth for which dashboards exist, so assignments and grants store the dashboard id as plain
text, validated against the registry on write and joined against it on read.

### Authentication

| | Lifetime | Where it lives | Revocable |
|---|---|---|---|
| **Access token** | `ACCESS_TOKEN_EXPIRY` (15m) | memory, sent as `Authorization: Bearer` | no — it expires |
| **Refresh token** | `REFRESH_TOKEN_EXPIRY` (30d) | HttpOnly cookie, `Path=/api/auth` | yes — it is a row |

Access-token claims carry identity only. Role, permissions, company status and scopes are
re-read on every request, so deactivating a user or changing their role takes effect on
their next call rather than at token expiry.

Refresh **rotates**: every refresh issues a new token and marks the old one replaced.
Presenting a replaced token means two parties hold the same secret, so the whole family —
the entire login chain — is revoked at once. Sessions are also revoked on logout, password
change, role change, deactivation, access reissue and company deactivation.

Only the HMAC of a refresh token is stored, keyed with `JWT_REFRESH_SECRET`, so a dump of
`refresh_tokens` cannot be replayed without a secret that lives outside the database.

`/api/auth/refresh` and `/api/auth/logout` are the only cookie-authenticated endpoints, so
they are the only ones needing CSRF protection: `SameSite=Strict`, a path-scoped cookie, and
a double-submit header checked in `src/middleware/session.js`. Everything else authenticates
with a bearer token, which is never sent ambiently.

### Authentication states

`UNAUTHENTICATED`, `AUTHENTICATED`, `PASSWORD_CHANGE_REQUIRED`, `ACCOUNT_DISABLED`,
`SESSION_EXPIRED`. `PASSWORD_CHANGE_REQUIRED` is enforced by `requirePasswordCurrent`, not
only shown by the UI: an account in that state is refused by every endpoint except the
password change itself.

### Response contract

Every response under `/api` is one of two shapes:

```json
{ "success": true,  "data": ... }
{ "success": false, "error": { "code": "INSUFFICIENT_PERMISSION", "message": "..." } }
```

`code` is the stable part — clients branch on it and never on the message. The codes are
listed in `src/api/response.js`, a code that is not there cannot be sent, and any 5xx
message is replaced with a generic one before it leaves the process.

### Endpoints

| Method | Path | Guard |
|---|---|---|
| `GET` | `/api/health` | — |
| `POST` | `/api/auth/login` | — |
| `POST` | `/api/auth/refresh`, `/api/auth/logout` | refresh cookie + CSRF header |
| `GET`/`POST` | `/api/auth/activation` | the activation token itself |
| `GET` | `/api/auth/me`, `/api/auth/sessions` | signed in |
| `POST` | `/api/auth/change-password` | signed in |
| `GET` | `/api/companies`, `/api/companies/:id` | `company.read` |
| `POST`/`PATCH`/`DELETE` | `/api/companies…` | `company.create` / `.update` / `.delete` |
| `GET`/`PUT`/`DELETE` | `/api/companies/:id/dashboards…` | `dashboard.assign` |
| `GET` | `/api/users`, `/api/users/:id`, `/api/users/options` | `user.read` |
| `POST` | `/api/users` | `user.create` |
| `PATCH`/`POST` | `/api/users/:id`, `/api/users/:id/activation` | `user.update` |
| `POST` | `/api/users/:id/activate` / `/deactivate` | `user.activate` / `.deactivate` |
| `DELETE` | `/api/users/:id` | `user.delete` |
| `GET` | `/api/users/:id/access` | `access.read` |
| `GET`/`PUT` | `/api/users/:id/scope`, `/api/users/scope-options` | `scope.read` / `scope.update` |
| `GET` | `/api/roles`, `/api/roles/:name/permissions`, `/api/roles/permissions` | `role.read` |
| `PUT` | `/api/roles/:name/permissions` | `role.update` |
| `GET` | `/api/groups…` | `group.read` |
| `POST`/`PUT`/`DELETE` | `/api/groups…` | `group.create` / `.update` / `.delete` |
| `GET` | `/api/access/dashboards` | signed in |
| `GET` | `/api/access/dashboards/:id/grants`, `/api/access/groups/:id/dashboards` | `access.read` |
| `PUT`/`DELETE` | `/api/access/dashboards/…` grants | `access.grant` / `.revoke` |
| `GET` | `/api/dashboard/:id` | `dashboard.read` + `view` on it |
| `GET` | `/api/dashboard/columns` | `data.read` + `view` on it |
| `PATCH`/`POST` | `/api/dashboard/:id/config`, `/api/dashboard/preview` | `dashboard.update` + `developer` on it |

The dashboard endpoints are **no longer open to anonymous callers**.

### Onboarding

There is no self-signup, and no administrator ever sets somebody else's password. An
account is created with **no credential at all**; a single-use, expiring activation link is
emailed, and its owner sets the password themselves.

A customer is onboarded one level up, at the company — the company and the person who will
run it are created by the same request:

```
SUPER_ADMIN creates a company, naming its administrator
   -> company row, COMPANY_ADMIN account and activation token: one transaction
   -> invitation emailed after it commits
   -> they open the link, choose a password, and are signed in as COMPANY_ADMIN
   -> from there they add their own users, by the same route

COMPANY_ADMIN creates a user
   -> account created with status "pending"
   -> activation token issued (stored as an HMAC, never in plain text)
   -> email sent with the application URL, their username and the link
   -> they open it, choose a password, and are signed in
```

The administrator is **not optional** on `POST /api/companies`. A company with nobody in it
cannot be signed into or administered; it does nothing but hold the name and slug that the
next attempt then collides with.

Creation and mail are all-or-nothing on both paths. If delivery fails, the account — and on
the company path the company with it — is removed again, because what would otherwise be
left behind holds the username and email address that the retry needs.

Both paths render the invitation through `auth/onboardingService.js`, so the wording, the
expiry and the security notice cannot drift apart between them.

"Reset access" (`POST /api/users/:id/activation`) is the same mechanism — it clears the
password, ends the sessions and sends a new link. It is the one path that does **not** undo
itself when delivery fails: the reset has already committed, so the account is left with no
password until a link gets through. That is the safe direction — the old password was meant
to stop working — and the error message says so outright rather than leaving it to be
discovered.

### Email

`src/email/emailService.js` is the only way the application sends mail. Business code calls
`sendEmail({ to, subject, text, html }, { consequence })` and knows nothing about transport;
swapping SMTP for SES, SendGrid or Graph is a new file under `src/email/providers/`.

`consequence` is what the caller did about a failure, in the caller's own words. Only the
caller knows: the same undelivered message rolls back a company on one path, a single
account on another, and nothing at all on the third.

SMTP is the only transport. There is deliberately no development mode that writes messages
to disk: every configuration either delivers or fails loudly, so the application can never
report success for an email nobody received.

The relay is configured in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`,
`SMTP_PASSWORD`, `EMAIL_FROM`) rather than in source, because `SMTP_PASSWORD` is a live
credential — an application-specific password grants ongoing send access to a real mailbox
for as long as it is valid. Missing or half-filled settings are a startup crash naming the
variable, and `transporter.verify()` runs at startup so bad credentials surface then rather
than as a failed onboarding hours later.

### Row-level data scopes

`user_data_scope` records which slices of the data a user may see. It is **stored and
configurable, but nothing filters on it yet** — every endpoint that touches scopes reports
`enforced: false`. Turning it on means doing *both* halves: injecting the predicates during
planning, **and** folding the acting user's scope into the cache key in
`query/queryCache.js`. Doing only the first would serve one user's rows to another out of
the cache.

Which columns a scope may be assigned on is runtime configuration, so it sits beside the
dashboard JSON:

```bash
cp config/rbac/scope-dimensions.example.json config/rbac/scope-dimensions.json
```

### First start

`bootstrapAppMeta()` runs on every start and is idempotent: it creates the tables, the
indexes, the three roles and — only when the users table is empty — the platform owner
declared in `src/config/appConfig.js`, flagged to change its password at first sign-in.
There is no database to create: the tables go into `DB_NAME`, beside the reporting data.

Bootstrap failure **is fatal**. Every endpoint now resolves an actor and checks a grant, so
a process that cannot reach the database cannot authorize anything; staying up would mean
serving 503 to everything while looking healthy to whatever restarts it.

Configuration is read at require time and validated: a missing `DB_HOST`, `DB_NAME`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `APPLICATION_URL` or `SMTP_HOST` is a startup
crash naming the variable. There are no fallback secrets — a default one is
indistinguishable at runtime from a correctly configured deployment, and forges every token
in the system.

### What is configured where

| | Where | Why |
|---|---|---|
| Database, `APPLICATION_URL`, signing secrets, SMTP | `.env` | deployment-specific, or a live credential |
| Token lifetimes, login throttling, query concurrency | `src/config/appConfig.js` | product decisions; a value that drifts per deployment is one nobody can reason about |
| Bootstrap owner's username, email and password | `src/config/appConfig.js` | a first-use credential, spent the moment it is used |

The bootstrap password being in source is a real trade-off: it is in version control, stays
in the history, and is identical in every deployment built from that source. What limits it
is that the seeded account carries `must_change_password`, so signing in once replaces it.

### PostgreSQL notes

The engine targets PostgreSQL only. The differences that shaped the code:

| | How it is handled |
|---|---|
| **Identifiers** | Double-quoted everywhere, always using the name read from the catalogue. Unquoted identifiers fold to lower case, so a real column `"Booking Date"` is unreachable without quotes - and a spec that spells it `booking date` must still emit the catalogue's spelling. `sqlGenerator` therefore *references* the catalogue name and *aliases* to the spec's, because the formatter reads rows back by the latter. |
| **Placeholders** | `config/pgPool.js` rewrites `?` into `$1, $2, …`, skipping anything inside quotes. The SQL here is frequently assembled - IN lists, multi-row inserts, optional fragments - and hand-numbering those is where an off-by-one hides as a wrong *value* bound to the right position. |
| **Date bucketing** | `to_char(col, 'YYYY-MM')`, and `to_char(to_date(col, <template>), …)` for string date columns. ISO weeks use `IYYY"-W"IW`, which cannot disagree with itself the way `YYYY` + `IW` would at a year boundary. |
| **Slicer filters** | Values arrive from a URL as strings, so a non-text column is compared as `col::text = $1` - comparing text to an integer is refused outright. `setup:indexes` creates a matching expression index, because a plain index cannot serve a cast. |
| **int8 and numeric** | node-postgres returns both as strings to protect precision. `config/pgPool.js` parses them to Number, because every `COUNT(*)` in this application is an int8 and a count arriving as `"1234"` breaks arithmetic and chart scales silently. Values beyond 2^53 would lose precision; for row counts and these aggregates that is unreachable. |
| **One database** | The RBAC tables and the reporting tables share `DB_NAME` and one pool. The RBAC tables are unqualified and resolve through `search_path`; reporting tables are schema-qualified from the dashboard spec, so `DB_SCHEMA` keeps the two sets from colliding over a name like `users`. |
| **Upserts** | `ON CONFLICT (cols) DO UPDATE`. Note that every assignment sees the row as it was *before* the statement - there is no left-to-right chaining - which is why `auth/loginThrottle.js` repeats its window test in each expression rather than computing it once. |

## Scripts

```bash
npm start                 # serve the API and the built frontend
npm run setup:indexes     # create indexes from dashboard metadata (--dry-run supported)
npm run reset:access      # email an account a new activation link, without a token
npm run test:e2e          # the RBAC/tenancy/token suite (see tests/rbac.e2e.js)
```

The suite brings its own SMTP relay and its own reporting table, so it needs a throwaway
database and the server pointed at that relay. `DB_NAME` goes on **both** processes — the
fixture connects through the application's own pool, which otherwise reads `.env` and
builds its table in the real database:

```bash
# terminal 1
DB_NAME=app_e2e PORT=8099 \
SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USERNAME= SMTP_PASSWORD= \
EMAIL_FROM=e2e@example.com npm start

# terminal 2
DB_NAME=app_e2e npm run test:e2e
```

Drop `app_e2e` between runs: the suite expects to start from an empty installation.

`reset:access` exists because the API needs an administrator who can sign in, and the case
it is for is that nobody can — if the only SUPER_ADMIN loses their password, bootstrap will
not help, because it only seeds an owner into an empty users table. It does exactly what
`POST /api/users/:id/activation` does and no more: it cannot set a password, and it never
prints the token.
