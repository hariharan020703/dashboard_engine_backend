# Context layer

Warehouse connections, and the datasets chosen from them. Everything the
feature adds to the API and the database is in this folder, so it can be read
— or removed — without reading the rest of the backend.

```
routes.js               the Express router, mounted at /api/context
connectorCatalogue.js   the warehouses this platform knows about
connectionService.js    company-scoped reads and writes; the token never leaves it
secretBox.js            AES-256-GCM seal/open for stored credentials
schema.js               this module's two tables
providers/domo.js       the only implemented provider
```

## Where it touches the rest of the application

Six lines, on purpose — the point of the folder is that sharing or merging this
feature does not collide with anything else:

| File | What was added |
|---|---|
| `src/routes/index.js` | `router.use('/context', …)` |
| `src/auth/appMetaSchema.js` | `await bootstrapContextLayer()` |
| `src/auth/permissionCatalogue.js` | `context.read`, `context.manage` |
| `src/auth/auditService.js` | three event names |
| `src/api/response.js` | `CONNECTOR_AUTH_FAILED`, `CONNECTOR_UNREACHABLE` |
| `.env` | `CREDENTIAL_SECRET` |

## Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/context/connectors` | `context.read` |
| `GET` | `/api/context/connections` | `context.read` |
| `POST` | `/api/context/connections` | `context.manage` |
| `GET` | `/api/context/connections/:id` | `context.read` |
| `POST` | `/api/context/connections/:id/verify` | `context.manage` |
| `GET` | `/api/context/connections/:id/datasets?limit=N` | `context.read` |
| `GET` | `/api/context/connections/:id/profile` | `context.read` |
| `GET` | `/api/context/connections/:id/tables/:tableId` | `context.read` |
| `PUT` | `/api/context/connections/:id/datasets` | `context.manage` |
| `DELETE` | `/api/context/connections/:id` | `context.manage` |

A connection belongs to exactly one company. A platform account must name the
company on create; a company account gets its own and a `companyId` in the body
is ignored — the same rule as creating a user.

## Credentials

A warehouse token is the one secret in this application that is stored
**reversibly**. Passwords are bcrypt hashes and refresh tokens are HMACs
because nothing ever needs the original back; a Domo token has to be presented
to Domo on every call, so it is encrypted with `CREDENTIAL_SECRET` rather than
hashed.

That is a real difference in exposure and worth stating plainly: a dump of
`context_connections` alone is useless, a dump plus the environment is not.
Rotating `CREDENTIAL_SECRET` invalidates every stored connection — they report
"the stored token could not be read" and have to be entered again.

The decrypted token never leaves `connectionService.js`. It is not in the
shaped response, not in the audit trail (`token` and `secret` are in
`FORBIDDEN_DETAIL_KEYS`), and not in any log line. What the UI shows is
`secretHint`, the last four characters.

## Domo

Domo has two credential models, and the screen asks for the second:

- **OAuth client** — id and secret, used against `api.domo.com`. The published,
  versioned public API.
- **Access token** — issued in Domo under Admin → Authentication → Access
  tokens, sent as `X-DOMO-Developer-Token` against the customer's **own**
  instance.

This is why the form asks for the instance as well as the token. A token
carries no address: it is issued by one instance and means nothing at another,
so there is nothing to infer it from.

Four instance endpoints are used, all in `providers/domo.js`:

| | |
|---|---|
| `GET /api/content/v2/users/me` | validates the token and reports whose it is |
| `GET /api/data/v3/datasources?limit=&offset=&part=` | lists datasets, paged |
| `GET /api/data/v3/datasources/{id}` | one dataset's record: counts, size, owner, timestamps |
| `POST /api/query/v1/execute/{id}` | `SELECT * LIMIT n` — the profile's columns, types and sample |

**These are not part of Domo's versioned public API.** They are the endpoints
Domo's own web client uses, and Domo can change them without notice. They are
kept together and named for that reason, and every failure reports the status
and Domo's own message — so if a shape changes, the error says where, and the
fix is this one file.

### Listing is capped

Listing is the slowest thing this connector does — an instance with a few thousand
datasets is dozens of round trips before the picker can draw anything, and nobody
chooses from a list that long by scrolling it. So a listing returns **20 by default**,
`?limit=N` raises it (1–500, refused outside that), and the response says which limit
was applied and whether anything was left behind:

```json
{ "datasets": [ … ], "fetchedAt": "…", "limit": 20, "truncated": true }
```

`truncated` is a **fact, not an inference**. The loop collects one row beyond the limit
and discards it, so an account holding exactly 20 datasets is distinguishable from one
holding thousands. That matters because the alternative is somebody selecting from what
looks like the whole warehouse and building a context that quietly omits most of it.

The extra row is a ceiling on the whole loop rather than a `+1` on each request. Asking
for "one more than is left" gets clipped by Domo's own cap of 50, so at a limit of 100 —
an exact multiple of the page size — the probe was never fetched and 137 datasets
reported as "all of them". `tests/contextLayer.test.js` pins that boundary.

### Why a GET

The dataset list is a GET rather than the UI's `POST .../datasources/search`.
The search endpoint takes a body whose shape is tied to Domo's own filter
model, and a body that is subtly wrong comes back **200 with no rows** — which
is indistinguishable from an account that genuinely has no datasets. A GET has
no body to get wrong.

### An unrecognised response is an error

`extractRows` accepts a bare array, `{dataSources}`, `{datasources}`,
`{searchObjects}`, `{results}`, `{items}` and `{searchResultsMap: {DATASET}}`.
Anything else throws `CONNECTOR_UNREACHABLE` and logs the response.

It deliberately does **not** fall back to an empty list. An earlier version
did, with `|| []` at the end of the lookup, and the result was the worst kind
of failure: a wrong endpoint produced a connection that said "connected" and
showed zero datasets, with no error anywhere to explain it. "I do not
understand this response" and "this account has no datasets" have to stay
distinguishable.

The log line carries the keys and a truncated sample, so a changed shape can
be fixed in one pass:

```
[domo] unrecognised response from /api/data/v3/datasources - keys: totalResultCount, somethingElse
[domo] sample: {"totalResultCount":42,"somethingElse":{}}
```

There is no credential in a dataset list, which is why it is safe to log.

Validation happens **before** anything is written. A connection row whose token
was never checked looks identical on screen to one that works, and the moment
it is relied on is the moment somebody is waiting for a context that will never
build.

## Profiling

`GET /connections/:id/profile` and `GET /connections/:id/tables/:tableId` are what the
workflow's Profile step reads. They deliberately differ in cost:

- **The tree** comes from **this** database — the dataset selection stored by
  `PUT /datasets`, with the counts captured at selection time. No warehouse call at all,
  so it draws instantly and an instance that is briefly unreachable does not empty the
  screen.
- **A table's detail** is read **live**, only when that table is opened: one
  dataset-detail call plus one `SELECT * FROM table LIMIT 500`. That query is the only
  place this API exposes per-column **types** at all, and the same response carries the
  sample rows and the values the statistics are computed from — so it is one round trip
  for three answers rather than three.

In Domo a dataset **is** a table; there is no schema layer beneath it, so each selected
dataset contributes exactly one table. A provider that genuinely nests tables under a
schema returns several, and neither the response shape nor the UI changes for it.

Statistics — null rate, distinct count, min/max — are computed **here**, over that
sample, and `statsSampleSize` travels with them so the screen can say what they describe.
A null rate presented without its basis reads as a fact about the whole table.

What this API surface does **not** expose is reported as `null`, never inferred: semantic
types, primary/foreign keys and a quality score. Guessing a key from a column called `id`
would be a claim the source never made.

`tableProfile` refuses an id outside the connection's own selection. The connection is
already company-scoped, so that is not the tenant boundary — it is the narrower statement
that this endpoint profiles the datasets somebody chose, and nothing else in the instance.

## What this does not do

Storing the chosen dataset ids, and profiling them, is where this feature stops. Building
a context from them — definitions, metrics, relationships — is a separate step against a
different service, and nothing here pretends to have done it.

## Adding a provider

1. A file under `providers/` exporting `normaliseHost`, `verify({ host, token })`,
   `listDatasets({ host, token, limit })` and, to support the Profile step,
   `getTableProfile({ host, token, datasetId })`. A provider without the last one is
   refused by `tableProfile` with a clear message rather than crashing.
2. Register it in `PROVIDERS` in `connectionService.js`.
3. Flip its `status` to `available` in `connectorCatalogue.js` and describe its
   credential fields there — the dialog is rendered from that data, so a new
   provider needs no new component.
