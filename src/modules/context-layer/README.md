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
| `GET` | `/api/context/connections/:id/datasets` | `context.read` |
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

Two instance endpoints are used, both in `providers/domo.js`:

| | |
|---|---|
| `GET /api/content/v2/users/me` | validates the token and reports whose it is |
| `GET /api/data/v3/datasources?limit=&offset=&sort=name` | lists datasets, paged |

**These are not part of Domo's versioned public API.** They are the endpoints
Domo's own web client uses, and Domo can change them without notice. They are
kept together and named for that reason, and every failure reports the status
and Domo's own message — so if a shape changes, the error says where, and the
fix is this one file.

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

## What this does not do

Storing the chosen dataset ids is where this feature stops. Building a context
from them is a separate step against a different service, and nothing here
pretends to have done it — `PUT /connections/:id/datasets` records a selection
and says so.

## Adding a provider

1. A file under `providers/` exporting `normaliseHost`, `verify({ host, token })`
   and `listDatasets({ host, token })`.
2. Register it in `PROVIDERS` in `connectionService.js`.
3. Flip its `status` to `available` in `connectorCatalogue.js` and describe its
   credential fields there — the dialog is rendered from that data, so a new
   provider needs no new component.
