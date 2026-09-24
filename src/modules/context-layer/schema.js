const { db, T } = require('../../config/database');
const { quoteIdentifier } = require('../../config/pgPool');

/**
 * The context layer's own tables.
 *
 * Declared here rather than in auth/appMetaSchema.js so this feature is one
 * folder: everything it adds to the database, the API and the UI can be read -
 * or removed - without touching the RBAC schema. `bootstrapAppMeta()` calls
 * `bootstrapContextLayer()` after its own tables exist, because both of these
 * reference `companies` and `users`.
 */

const q = quoteIdentifier;

/**
 * This module's tables, quoted once. Deliberately not added to the shared `T`.
 *
 * The names are `connections` and `datasets` rather than the longer
 * `context_connections` / `context_connection_datasets` they used to carry,
 * because this application is no longer the only reader. The Context Layer
 * service (Elze-backend) reads the same two tables under these names -
 * `mcp-domo/credentials_client.py` resolves a data_source_id with
 * `SELECT provider, host, secret FROM connections WHERE id = %s`, and
 * `adk_agents/api/db.py` checks a workspace with
 * `SELECT 1 FROM connections WHERE id = %s`.
 *
 * That service is not ours to change, so the name it expects is the name that
 * wins. Renaming here rather than adding a view keeps one set of rows with one
 * spelling: a view would work for the reads, but the writes below would still
 * be going somewhere the other service never looks.
 */
const CT = {
  connections: q('connections'),
  datasets: q('datasets'),
  /*
   * The two below are OURS alone, unlike the two above.
   *
   * `context_objects` belongs to the Context Layer service and this
   * application only reads it and sets the three columns that exist for
   * review. These two carry what that schema has no room for, so neither
   * service has to change for the other.
   */
  reviews: q('context_object_reviews'),
  // Legacy: superseded by `versions`, kept so its rows can be copied across.
  publications: q('context_publications'),
  versions: q('context_layer_versions'),
};

const TABLES = [
  /*
   * One saved warehouse connection, owned by exactly one company.
   *
   * `company_id` is NOT NULL: a connection is a tenant's credential for a
   * tenant's data, and there is no such thing as a platform-wide one. A
   * platform account creating one has to say which company it is for, the same
   * way it does when creating a user.
   *
   * `secret` holds the provider credential encrypted with CREDENTIAL_SECRET -
   * see secretBox.js for why this one is reversible when nothing else is.
   */
  `CREATE TABLE IF NOT EXISTS ${CT.connections} (
     id               UUID         PRIMARY KEY,
     company_id       INTEGER      NOT NULL REFERENCES ${T.companies} (id) ON DELETE CASCADE,
     provider         VARCHAR(32)  NOT NULL,
     name             VARCHAR(120) NOT NULL,
     host             VARCHAR(190) NOT NULL,
     secret           TEXT         NOT NULL,
     secret_hint      VARCHAR(24)  NOT NULL,
     status           VARCHAR(16)  NOT NULL DEFAULT 'connected',
     last_error       TEXT         NULL,
     last_verified_at TIMESTAMPTZ  NULL,
     created_by       INTEGER      NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
     CONSTRAINT uq_context_connections_name UNIQUE (company_id, provider, name)
   )`,

  /*
   * The datasets chosen from a connection, which is the handoff this whole
   * screen exists to produce: a context is built from dataset ids, and this is
   * where the selection is remembered between the moment somebody ticks the
   * boxes and the moment something downstream reads them.
   *
   * The name and counts are copies taken at selection time, so the list still
   * renders when the warehouse is unreachable. They are a cache, not the
   * record - `dataset_id` is.
   */
  `CREATE TABLE IF NOT EXISTS ${CT.datasets} (
     connection_id UUID         NOT NULL REFERENCES ${CT.connections} (id) ON DELETE CASCADE,
     dataset_id    VARCHAR(190) NOT NULL,
     name          VARCHAR(255) NULL,
     row_count     BIGINT       NULL,
     column_count  INTEGER      NULL,
     selected_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
     selected_by   INTEGER      NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     PRIMARY KEY (connection_id, dataset_id)
   )`,

  /*
   * A human's decision about one extracted fact.
   *
   * `context_objects` has `verified`, `reviewed_by` and `reviewed_at`, and
   * this application does set them - `verified` is what the read-side MCP
   * server and the analyst agent filter on, so an approval has to land there
   * or it means nothing downstream.
   *
   * What a boolean cannot express is the difference between "not looked at
   * yet", "looked at and rejected" and "skipped for now", and those are three
   * different things to the person working through a queue of two hundred.
   * So the four-state decision lives here, and `contextStore.js` keeps the
   * boolean in step with it inside one transaction.
   *
   * No foreign key to `context_objects`: that table belongs to the other
   * service, and a constraint from here would make its migrations our problem.
   * A row whose object has since been deleted is harmless and is cleaned up by
   * the join, which simply finds nothing.
   */
  `CREATE TABLE IF NOT EXISTS ${CT.reviews} (
     object_id     UUID        PRIMARY KEY,
     connection_id UUID        NOT NULL REFERENCES ${CT.connections} (id) ON DELETE CASCADE,
     status        VARCHAR(16) NOT NULL,
     note          TEXT        NULL,
     reviewed_by   INTEGER     NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT chk_context_review_status
       CHECK (status IN ('pending','approved','rejected','skipped'))
   )`,

  /*
   * A published context: a named, versioned snapshot of approved facts.
   *
   * The NAME is what the step exists for. A connection is "Domo - Sales"; a
   * published context is "Revenue" or "Site safety" - what the thing is FOR,
   * which is not the same as where the data came from, and which one
   * connection can produce several of. Hence the version being unique per
   * (connection, name) rather than per connection: republishing "Revenue"
   * makes v2 of Revenue, while "Site safety" from the same connection starts
   * again at v1.
   *
   * `snapshot` holds the facts as they were at that moment rather than
   * pointing at live rows. A version that changed whenever somebody edited a
   * description would not be a version.
   */
  `CREATE TABLE IF NOT EXISTS ${CT.publications} (
     id            UUID         PRIMARY KEY,
     connection_id UUID         NOT NULL REFERENCES ${CT.connections} (id) ON DELETE CASCADE,
     company_id    INTEGER      NOT NULL REFERENCES ${T.companies} (id) ON DELETE CASCADE,
     name          VARCHAR(120) NOT NULL,
     version       INTEGER      NOT NULL,
     session_id    TEXT         NULL,
     object_count  INTEGER      NOT NULL DEFAULT 0,
     stats         JSONB        NOT NULL DEFAULT '{}'::jsonb,
     snapshot      JSONB        NOT NULL DEFAULT '[]'::jsonb,
     notify_team   BOOLEAN      NOT NULL DEFAULT FALSE,
     published_by  INTEGER      NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     published_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
     CONSTRAINT uq_context_publication_version UNIQUE (connection_id, name, version)
   )`,

  /*
   * One version of a context, from first edit to publication.
   *
   * Replaces `context_publications`, which could only record the END of the
   * workflow. A context now exists from the moment somebody starts building
   * it: the first write in the builder (a connection, a dataset selection, an
   * extraction, a review decision) opens a `draft`, and publishing turns that
   * same row into `published`.
   *
   * Editing after publication never touches the published row. The next write
   * opens a NEW draft - version n+1, `based_on_id` pointing at what it was
   * edited from - so v1 stays exactly as it was published while v2 is being
   * worked on. Hence at most one draft per connection (the partial unique
   * index below) and any number of published rows.
   *
   * The version counts per (connection, name), as publications always did:
   * republishing "Revenue" makes v2 of Revenue, while "Site safety" from the
   * same connection starts at v1. A draft carries the version it WILL get
   * under its current name; publishing under a different name recomputes it.
   *
   * `snapshot` holds the approved facts as they were at publication. It is
   * empty on a draft - a draft's facts are the live `context_objects` rows,
   * which is exactly why the published copy has to be stored.
   *
   * `extraction_*` is the report of the run that produced this version's facts.
   * The rows themselves live in `context_objects`; the prose account of the run
   * lives here so Understand can show it again after a reload.
   */
  `CREATE TABLE IF NOT EXISTS ${CT.versions} (
     id                UUID         PRIMARY KEY,
     connection_id     UUID         NOT NULL REFERENCES ${CT.connections} (id) ON DELETE CASCADE,
     company_id        INTEGER      NOT NULL REFERENCES ${T.companies} (id) ON DELETE CASCADE,
     name              VARCHAR(120) NOT NULL,
     version           INTEGER      NOT NULL,
     status            VARCHAR(16)  NOT NULL DEFAULT 'draft',
     current_step      VARCHAR(16)  NULL,
     dataset_ids       JSONB        NOT NULL DEFAULT '[]'::jsonb,
     based_on_id       UUID         NULL REFERENCES ${CT.versions} (id) ON DELETE SET NULL,
     session_id        TEXT         NULL,
     extraction_mode   VARCHAR(16)  NULL,
     extraction_report TEXT         NULL,
     extracted_at      TIMESTAMPTZ  NULL,
     object_count      INTEGER      NOT NULL DEFAULT 0,
     stats             JSONB        NOT NULL DEFAULT '{}'::jsonb,
     snapshot          JSONB        NOT NULL DEFAULT '[]'::jsonb,
     notify_team       BOOLEAN      NOT NULL DEFAULT FALSE,
     created_by        INTEGER      NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
     updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
     published_by      INTEGER      NULL REFERENCES ${T.users} (id) ON DELETE SET NULL,
     published_at      TIMESTAMPTZ  NULL,
     CONSTRAINT chk_context_version_status CHECK (status IN ('draft','published')),
     CONSTRAINT chk_context_version_published
       CHECK (status <> 'published' OR published_at IS NOT NULL),
     CONSTRAINT uq_context_layer_version UNIQUE (connection_id, name, version)
   )`,
];

const INDEXES = [
  // A person edited what the run wrote: "Human override" in Understand, and
  // kept as-is when the demo extraction is re-run.
  `ALTER TABLE ${CT.reviews} ADD COLUMN IF NOT EXISTS edited BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS idx_context_connections_company ON ${CT.connections} (company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_object_reviews_connection
     ON ${CT.reviews} (connection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_publications_connection
     ON ${CT.publications} (connection_id, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_context_publications_company
     ON ${CT.publications} (company_id)`,
  // At most one draft per connection: the thing being edited right now.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_context_layer_one_draft
     ON ${CT.versions} (connection_id) WHERE status = 'draft'`,
  `CREATE INDEX IF NOT EXISTS idx_context_layer_versions_connection
     ON ${CT.versions} (connection_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_context_layer_versions_company
     ON ${CT.versions} (company_id)`,
];

/*
 * Carries every row of the legacy publications table into `versions`.
 *
 * Same id, so it runs on every start and copies each row exactly once:
 * ON CONFLICT DO NOTHING skips anything already there, by id or by
 * (connection, name, version). Nothing writes the legacy table any more.
 */
const BACKFILL = `
  INSERT INTO ${CT.versions}
    (id, connection_id, company_id, name, version, status, current_step, session_id,
     object_count, stats, snapshot, notify_team, created_by, created_at, updated_at,
     published_by, published_at)
  SELECT id, connection_id, company_id, name, version, 'published', 'publish', session_id,
         object_count, stats, snapshot, notify_team, published_by, published_at, published_at,
         published_by, published_at
    FROM ${CT.publications}
  ON CONFLICT DO NOTHING`;

/** Creates this module's tables. Idempotent; called once at startup. */
async function bootstrapContextLayer() {
  for (const ddl of TABLES) await db.raw(ddl);
  for (const ddl of INDEXES) await db.raw(ddl);
  await db.raw(BACKFILL);
}

module.exports = { CT, bootstrapContextLayer };
