# Data analyst agent

Reserved. Nothing is implemented here yet.

The folder exists now so the feature has somewhere to land that does not
overlap with the context layer or with the rest of the backend — the same
reason `context-layer` is a folder rather than files scattered across
`src/routes` and `src/auth`.

## When it is built

Follow the shape `../context-layer` already uses, so the two stay independent:

```
routes.js     the Express router, mounted at /api/agent
schema.js     its own tables, called from bootstrapAppMeta()
...           services and providers
```

and wire it in with the same small set of edits:

| File | What to add |
|---|---|
| `src/routes/index.js` | `router.use('/agent', require('../modules/data-analyst-agent/routes'))` |
| `src/auth/appMetaSchema.js` | `await bootstrapAgent()` after the RBAC tables |
| `src/auth/permissionCatalogue.js` | its permissions, and defaults for `COMPANY_ADMIN` / `USER` |
| `src/auth/auditService.js` | its event names |

## What it will need from the context layer

The datasets somebody selected, which are already recorded:
`GET /api/context/connections/:id` returns `selectedDatasets`, each with the
provider's own `id`. Read them through that endpoint rather than querying
`context_connection_datasets` directly — the company check lives in
`connectionService.js`, and a direct query is a tenant boundary nobody
reviewed.
