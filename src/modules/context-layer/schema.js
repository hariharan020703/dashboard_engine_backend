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
  publications: q('context_publications'),
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
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_context_connections_company ON ${CT.connections} (company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_object_reviews_connection
     ON ${CT.reviews} (connection_id)`,
  `CREATE INDEX IF NOT EXISTS idx_context_publications_connection
     ON ${CT.publications} (connection_id, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_context_publications_company
     ON ${CT.publications} (company_id)`,
];

/** Creates this module's tables. Idempotent; called once at startup. */
async function bootstrapContextLayer() {
  for (const ddl of TABLES) await db.raw(ddl);
  for (const ddl of INDEXES) await db.raw(ddl);
}

module.exports = { CT, bootstrapContextLayer };
