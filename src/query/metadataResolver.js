const { db } = require('../config/database');
const { optional } = require('../config/configError');
const { fail } = require('../api/response');
const SchemaCache = require('./schemaCache');

const cache = new SchemaCache();
const inflight = new Map();

/**
 * Discovers and validates the shape of a dashboard's source table.
 *
 * Everything the engine knows about a table comes from here, read out of the
 * live catalogue rather than declared in the dashboard JSON, so a column that
 * has been renamed or retyped fails at planning time with a clear message
 * instead of producing wrong SQL.
 */

/*
 * Classification is by PostgreSQL's internal type name (`pg_type.typname`)
 * rather than by the information_schema spelling, because the internal names
 * are short and stable - `int4`, `varchar`, `timestamptz` - where
 * information_schema renders them as prose like "timestamp with time zone"
 * that differs between versions and is awkward to match on.
 */
const DATE_TYPES = new Set(['date', 'timestamp', 'timestamptz', 'time', 'timetz']);
const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money']);
const STRING_TYPES = new Set(['text', 'varchar', 'bpchar', 'char', 'name', 'citext', 'uuid']);

// Interpolated into SQL as an identifier, so the allowlist is also the
// injection guard. PostgreSQL would permit far more inside double quotes; this
// is deliberately narrower than what is legal.
const IDENTIFIER_RE = /^[A-Za-z0-9_$]+$/;

/** The schema a dashboard's tables live in when its spec does not say. */
const DEFAULT_SCHEMA = optional('DB_SCHEMA', 'public');

function classifyType(typname) {
  const t = String(typname || '').toLowerCase();
  return {
    type: t,
    isDate: DATE_TYPES.has(t),
    isNumeric: NUMERIC_TYPES.has(t),
    isString: STRING_TYPES.has(t),
    isTemporal: DATE_TYPES.has(t),
  };
}

function tableKey(schema, table) {
  return `${schema}.${table}`;
}

function getSource(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Dashboard spec must be a non-null object');
  }

  const dataSource = spec.dataSource || spec.source || {};
  let table = dataSource.table || dataSource.name || null;

  if (!table && typeof spec.dataset === 'string') {
    table = spec.dataset;
  } else if (!table && spec.dataset && typeof spec.dataset === 'object') {
    table = spec.dataset.table || null;
  }

  if (!table || typeof table !== 'string' || !table.trim()) {
    throw new Error('Dashboard metadata is missing a source table. Provide dataSource.table in the dashboard JSON.');
  }

  table = table.trim();
  if (!IDENTIFIER_RE.test(table)) {
    throw new Error(`Invalid table name "${table}". Allowed characters: letters, digits, underscore, $`);
  }

  const schema = String(
    dataSource.schema ||
    (spec.dataset && typeof spec.dataset === 'object' ? spec.dataset.schema : null) ||
    DEFAULT_SCHEMA
  ).trim();

  if (!IDENTIFIER_RE.test(schema)) {
    throw new Error(`Invalid schema name "${schema}". Allowed characters: letters, digits, underscore, $`);
  }

  /*
   * `database` is accepted for the dashboards that already declare one, but it
   * can only ever name the database this process is connected to.
   *
   * PostgreSQL has no cross-database queries: a connection reaches one database
   * and nothing else. Silently ignoring a mismatch would read the wrong table
   * and report numbers from it, so it is an error - and the message points at
   * `schema`, which is how a spec selects a different group of tables.
   */
  const declared = dataSource.database ||
    (spec.dataset && typeof spec.dataset === 'object' ? spec.dataset.database : null) || null;

  if (declared && declared !== process.env.DB_NAME) {
    throw new Error(
      `Dashboard names database "${declared}" but this server is connected to ` +
      `"${process.env.DB_NAME}". PostgreSQL cannot query across databases - use ` +
      '"schema" in dataSource to select a schema within the connected database, ' +
      'or point DB_NAME at that database.'
    );
  }

  return { database: process.env.DB_NAME, schema, table };
}

async function fetchTableMetadata(source) {
  /*
   * Read from pg_catalog rather than information_schema for two reasons:
   * `format_type` renders the declared type exactly as a human wrote it
   * ("character varying(50)"), which is what the column catalogue shows; and
   * `pg_type.typname` gives the short internal name the classifier wants.
   * information_schema offers one or the other, never both.
   */
  const { rows } = await db.query(
    `SELECT a.attname                               AS name,
            format_type(a.atttypid, a.atttypmod)    AS column_type,
            t.typname                               AS typname,
            NOT a.attnotnull                        AS nullable
       FROM pg_attribute a
       JOIN pg_class     c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type      t ON t.oid = a.atttypid
      WHERE n.nspname = ?
        AND c.relname = ?
        AND c.relkind IN ('r','v','m','f','p')
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [source.schema, source.table]
  );

  if (!rows.length) {
    /*
     * A typed error, not a bare one. This is the single most likely thing to be
     * wrong on a new deployment - the dashboard JSON names a table the database
     * does not have yet - and as a plain Error it reached the client as
     * "Something went wrong on our side", which says nothing about what to fix.
     */
    throw fail(
      'DASHBOARD_SOURCE_UNAVAILABLE',
      `This dashboard reads "${source.schema}.${source.table}", which does not exist in database ` +
      `"${source.database}". Load that table, or point the dashboard's dataSource at one that exists.`
    );
  }

  const columns = rows.map((c) => ({
    name: c.name,
    ...classifyType(c.typname),
    columnType: c.column_type,
    nullable: c.nullable,
  }));

  const columnMap = new Map();
  const byLower = new Map();
  for (const c of columns) {
    columnMap.set(c.name, c);
    byLower.set(String(c.name).toLowerCase(), c);
  }

  return {
    database: source.database,
    schema: source.schema,
    table: source.table,
    columns,
    columnMap,
    byLower,
  };
}

async function getTableMetadata(source) {
  const key = tableKey(source.schema, source.table);
  const cached = cache.get(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const promise = fetchTableMetadata(source)
    .then((meta) => {
      cache.set(key, meta);
      return meta;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * Resolves a column by name, falling back to a case-insensitive match.
 *
 * The fallback earns its place because an unquoted identifier is folded to
 * lower case: a table created from a spreadsheet header may hold "Booking Date"
 * while a dashboard written by hand says "booking date". The returned metadata
 * carries the real, exact name, and that is what every generated statement
 * quotes.
 */
function resolveColumn(meta, name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Invalid column name: empty or non-string');
  }
  const exact = meta.columnMap.get(name);
  if (exact) return exact;
  const folded = meta.byLower.get(String(name).toLowerCase());
  if (folded) return folded;
  throw new Error(`Unknown column "${name}" in table "${meta.table}"`);
}

function resolveSourceMetadata(spec) {
  const source = getSource(spec);
  return getTableMetadata(source).then((meta) => {
    const dataSource = spec.dataSource || spec.source || {};
    const dateParse =
      (dataSource && (dataSource.dateParse || dataSource.stringDates)) ||
      (spec && spec.dateParse) ||
      {};
    return {
      source,
      table: meta,
      columns: meta.columnMap,
      dateParse: typeof dateParse === 'object' && dateParse ? dateParse : {},
    };
  });
}

module.exports = {
  resolveColumn,
  resolveSourceMetadata,
  DEFAULT_SCHEMA,
};
