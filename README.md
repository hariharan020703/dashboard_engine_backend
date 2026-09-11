# Backend — API + Query Engine

Express API in front of a generic, metadata-driven query engine. Nothing in `src/query`
knows anything about a particular dashboard: table names, columns, measures, dimensions,
filters, aggregations and date grains all arrive from dashboard JSON and are validated
against `INFORMATION_SCHEMA` before reaching SQL.

## Layout

```
backend/
├── src/
│   ├── app/                         HTTP layer
│   │   ├── server.js                entry point: express app, static files, listen
│   │   ├── httpError.js             error code -> HTTP status
│   │   ├── middleware/
│   │   │   └── requestTimer.js
│   │   └── routes/
│   │       ├── index.js             everything under /api, plus the /api 404
│   │       └── dashboardRoutes.js   the four dashboard endpoints
│   │
│   ├── config/
│   │   ├── env.js                   loads .env once, resolves directory roots
│   │   └── database.js              MySQL connection pool
│   │
│   ├── dashboard/
│   │   ├── dashboardRegistry.js     dashboardId -> dashboard JSON (file-backed)
│   │   └── dashboardService.js      hydrates a spec into the API response shape
│   │
│   ├── query/                       the engine — one folder per pipeline stage
│   │   ├── queryEngine.js           orchestrator (plan -> optimize -> SQL -> run -> format)
│   │   ├── semantic/semanticLayer.js    SQL vocabulary: aggregations, operators,
│   │   │                                date grains, identifier quoting, predicates
│   │   ├── metadata/                    INFORMATION_SCHEMA discovery + 5-minute cache
│   │   ├── planning/queryPlanner.js     spec -> validated plans (measures, dimensions,
│   │   │                                date groups, sort terms, filters)
│   │   ├── optimization/queryOptimizer.js  merges compatible KPI queries
│   │   ├── sql/sqlGenerator.js          plans -> parameterised SQL
│   │   ├── execution/queryExecutor.js   runs SQL, times it, logs failures
│   │   └── formatting/resultFormatter.js rows -> the frontend contract
│   │
│   └── cache/queryCache.js          Redis + in-memory query cache
│
├── config/dashboards/               runtime dashboard metadata (not source)
│   └── default.json                 served by /api/dashboard/view
│
└── scripts/setupIndexes.js          creates indexes for slicer/groupBy columns
```

## Request flow

```
GET /api/dashboard/view
  app/routes/dashboardRoutes.js        parse slicer filters from the query string
  dashboard/dashboardRegistry.js       dashboardId -> dashboard JSON
  dashboard/dashboardService.js        hydrateView
  query/queryEngine.js                 hydrateDashboard
    query/metadata/metadataResolver    resolve + validate table and columns
    query/planning/queryPlanner        one isolated plan per KPI / card / slicer
    query/optimization/queryOptimizer  merge compatible KPI queries
    query/sql/sqlGenerator             parameterised SQL
    cache/queryCache                   keyed on SQL + bound params
    query/execution/queryExecutor      MySQL, bounded concurrency
    query/formatting/resultFormatter   rows -> KPIs / cards / slicers
  JSON response
```

Each KPI, card and slicer is planned, executed and formatted independently: one invalid
visual returns `error` metadata for itself while the rest of the dashboard still renders.
Filter resolution is the one request-level failure, because a silently unapplied filter
would misstate every visual.

## Adding a dashboard

Drop a JSON file into `config/dashboards/<id>.json`; it is immediately available at
`/api/dashboard/<id>`. Ids are restricted to `[A-Za-z0-9_-]{1,64}`, which is also the
path-traversal guard. No engine code changes.

## Scripts

```bash
npm start                 # serve the API and the built frontend
npm run setup:indexes     # create indexes from dashboard metadata (--dry-run supported)
```
