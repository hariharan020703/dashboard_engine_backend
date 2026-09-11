const pool = require('../../config/database');
const SchemaCache = require('./schemaCache');

const cache = new SchemaCache();
const inflight = new Map();

const DATE_TYPES = new Set(['date', 'datetime', 'timestamp', 'year']);
const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'bit']);
const STRING_TYPES = new Set(['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'enum', 'set']);

const TABLE_NAME_RE = /^[A-Za-z0-9_$]+$/;

function classifyType(dataType) {
  const t = String(dataType || '').toLowerCase();
  return {
    type: t,
    isDate: DATE_TYPES.has(t),
    isNumeric: NUMERIC_TYPES.has(t),
    isString: STRING_TYPES.has(t),
    isTemporal: DATE_TYPES.has(t),
  };
}

function tableKey(database, table) {
  return `${database || ''}.${table}`;
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

  if (!TABLE_NAME_RE.test(table)) {
    throw new Error(`Invalid table name "${table}". Allowed characters: letters, digits, underscore, $`);
  }

  let database = dataSource.database || (spec.dataset && typeof spec.dataset === 'object' ? spec.dataset.database : null) || null;
  if (!database) database = process.env.DB_NAME || '';
  if (database && !/^[A-Za-z0-9_$]+$/.test(database)) {
    throw new Error(`Invalid database name "${database}"`);
  }

  return { database, table };
}

async function fetchTableMetadata(source) {
  const [tables] = await pool.query(
    'SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ? AND (? = "" OR TABLE_SCHEMA = ?)',
    [source.table, source.database || '', source.database || '']
  );

  if (!tables.length) {
    throw new Error(`Table not found: ${source.database ? source.database + '.' : ''}${source.table}`);
  }

  const [cols] = await pool.query(
    'SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, ORDINAL_POSITION ' +
    'FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND (? = "" OR TABLE_SCHEMA = ?) ORDER BY ORDINAL_POSITION',
    [source.table, source.database || '', source.database || '']
  );

  const columns = cols.map((c) => ({
    name: c.COLUMN_NAME,
    ...classifyType(c.DATA_TYPE),
    columnType: c.COLUMN_TYPE,
    nullable: c.IS_NULLABLE === 'YES',
  }));

  const columnMap = new Map();
  const byLower = new Map();
  for (const c of columns) {
    columnMap.set(c.name, c);
    byLower.set(String(c.name).toLowerCase(), c);
  }

  return {
    database: source.database,
    table: source.table,
    columns,
    columnMap,
    byLower,
  };
}

async function getTableMetadata(source) {
  const key = tableKey(source.database, source.table);
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
};