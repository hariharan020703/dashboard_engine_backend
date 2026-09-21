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

/** This module's tables, quoted once. Deliberately not added to the shared `T`. */
const CT = {
  connections: q('context_connections'),
  datasets: q('context_connection_datasets'),
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
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_context_connections_company ON ${CT.connections} (company_id)`,
];

/** Creates this module's tables. Idempotent; called once at startup. */
async function bootstrapContextLayer() {
  for (const ddl of TABLES) await db.raw(ddl);
  for (const ddl of INDEXES) await db.raw(ddl);
}

module.exports = { CT, bootstrapContextLayer };
