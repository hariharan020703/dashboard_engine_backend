const AGGREGATIONS = {
  SUM: 'SUM',
  AVERAGE: 'AVG',
  AVG: 'AVG',
  MEAN: 'AVG',
  COUNT: 'COUNT',
  COUNTDISTINCT: 'COUNT_DISTINCT',
  COUNT_DISTINCT: 'COUNT_DISTINCT',
  DISTINCT_COUNT: 'COUNT_DISTINCT',
  MIN: 'MIN',
  MAX: 'MAX',
};

// Aggregations that are only meaningful over numeric columns. COUNT / COUNT_DISTINCT
// are intentionally absent: they are valid over any column type.
const AGG_REQUIRES_NUMERIC = new Set(['SUM', 'AVG']);
// MIN / MAX are valid over anything with a natural ordering.
const AGG_REQUIRES_ORDERABLE = new Set(['MIN', 'MAX']);

const OPERATORS = {
  IN: 'IN',
  EQ: '=',
  EQUALS: '=',
  '=': '=',
  NE: '!=',
  NEQ: '!=',
  '!=': '!=',
  GT: '>',
  '>': '>',
  GTE: '>=',
  '>=': '>=',
  LT: '<',
  '<': '<',
  LTE: '<=',
  '<=': '<=',
  LIKE: 'LIKE',
  BETWEEN: 'BETWEEN',
};

// Aliases, in the same spirit as AGGREGATIONS: callers may spell a direction
// either way and the SQL keyword is the same.
const SORT_DIRECTIONS = {
  ASC: 'ASC',
  ASCENDING: 'ASC',
  DESC: 'DESC',
  DESCENDING: 'DESC',
};

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DEFAULT_DATE_GRAIN = 'MONTH';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function monthName(month) {
  const idx = Number(month) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx > 11) {
    throw new RangeError(`Month out of range: ${month}`);
  }
  return MONTH_NAMES[idx];
}

/**
 * Every supported date grain, described in one place:
 *   format   - MySQL DATE_FORMAT pattern used to bucket rows
 *   pattern  - parses the bucket value that comes back from MySQL
 *   sortKey  - strictly monotonic within the grain, so buckets never collide
 *   display  - human label for the bucket
 * Adding a grain here is the only change needed to support it end to end.
 */
const DATE_GRAINS = {
  HOUR: {
    key: 'HOUR',
    format: '%Y-%m-%d %H:00',
    pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/,
    sortKey: (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
    display: (m) => `${monthName(m[2])} ${Number(m[3])}, ${m[1]} ${pad2(Number(m[4]))}:${m[5]}`,
  },
  DAY: {
    key: 'DAY',
    format: '%Y-%m-%d',
    pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    sortKey: (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    display: (m) => `${monthName(m[2])} ${Number(m[3])}, ${m[1]}`,
  },
  WEEK: {
    key: 'WEEK',
    // %x/%v are the ISO week-numbering year and week, so they always agree.
    format: '%x-W%v',
    pattern: /^(\d{4})-W(\d{1,2})$/,
    sortKey: (m) => Number(m[1]) * 100 + Number(m[2]),
    display: (m) => `W${pad2(Number(m[2]))} ${m[1]}`,
  },
  MONTH: {
    key: 'MONTH',
    format: '%Y-%m',
    pattern: /^(\d{4})-(\d{1,2})$/,
    sortKey: (m) => Number(m[1]) * 100 + Number(m[2]),
    display: (m) => `${monthName(m[2])} ${m[1]}`,
  },
  YEAR: {
    key: 'YEAR',
    format: '%Y',
    pattern: /^(\d{4})$/,
    sortKey: (m) => Number(m[1]),
    display: (m) => String(m[1]),
  },
};

// Most specific first so an HOUR bucket is never mistaken for a DAY bucket.
const GRAIN_INFERENCE_ORDER = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

function quoteIdentifier(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function escapeLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function resolveAggregation(fn) {
  const upper = String(fn || 'SUM').toUpperCase();
  const sqlFn = AGGREGATIONS[upper];
  if (!sqlFn) {
    throw new Error(`Unknown aggregation "${fn}". Supported: ${Object.keys(AGGREGATIONS).join(', ')}`);
  }
  return sqlFn;
}

function resolveOperator(op) {
  const upper = String(op || 'IN').toUpperCase();
  const sql = OPERATORS[upper];
  if (!sql) {
    throw new Error(`Unsupported filter operator "${op}". Supported: ${Object.keys(OPERATORS).join(', ')}`);
  }
  return sql;
}

function resolveSortDirection(direction) {
  const raw = direction == null ? '' : String(direction).trim();
  if (!raw) return SORT_DIRECTIONS.ASC;
  const sql = SORT_DIRECTIONS[raw.toUpperCase()];
  if (!sql) {
    throw new Error(`Unsupported sort direction "${direction}". Supported: ${Object.keys(SORT_DIRECTIONS).join(', ')}`);
  }
  return sql;
}

function resolveDateGrain(grain) {
  const raw = grain == null ? '' : String(grain).trim();
  if (!raw) return DATE_GRAINS[DEFAULT_DATE_GRAIN];
  const resolved = DATE_GRAINS[raw.toUpperCase()];
  if (!resolved) {
    throw new Error(`Unsupported date grain "${grain}". Supported: ${Object.keys(DATE_GRAINS).join(', ')}`);
  }
  return resolved;
}

function inferGrainFromPeriod(period) {
  for (const key of GRAIN_INFERENCE_ORDER) {
    if (DATE_GRAINS[key].pattern.test(period)) return DATE_GRAINS[key];
  }
  return null;
}

function grainForPeriod(period, grain) {
  if (grain) {
    const raw = String(grain).trim().toUpperCase();
    if (DATE_GRAINS[raw]) return DATE_GRAINS[raw];
  }
  return inferGrainFromPeriod(period);
}

function isDateColumn(colMeta) {
  return !!(colMeta && (colMeta.isDate || colMeta.isTemporal));
}

function isNumericColumn(colMeta) {
  return !!(colMeta && colMeta.isNumeric);
}

function isStringColumn(colMeta) {
  return !!(colMeta && colMeta.isString);
}

function describeColumnType(colMeta) {
  if (!colMeta) return 'of unknown type';
  if (isNumericColumn(colMeta)) return `numeric (${colMeta.type})`;
  if (isDateColumn(colMeta)) return `a date/time column (${colMeta.type})`;
  if (isStringColumn(colMeta)) return `text (${colMeta.type})`;
  return `of unsupported type (${colMeta.type || 'unknown'})`;
}

/**
 * Resolves an aggregation and checks it against the column's real database type,
 * so a mis-typed measure fails loudly instead of letting MySQL coerce text to 0.
 */
function validateAggregation(aggFn, column, colMeta, tableName) {
  const sqlAgg = resolveAggregation(aggFn);
  const where = tableName ? ` in table "${tableName}"` : '';

  if (AGG_REQUIRES_NUMERIC.has(sqlAgg) && !isNumericColumn(colMeta)) {
    throw new Error(
      `Aggregation "${sqlAgg}" requires a numeric column, but "${column}"${where} is ${describeColumnType(colMeta)}. ` +
      'Use COUNT or COUNT_DISTINCT for non-numeric columns, or point the measure at a numeric column.'
    );
  }

  if (
    AGG_REQUIRES_ORDERABLE.has(sqlAgg) &&
    !isNumericColumn(colMeta) &&
    !isDateColumn(colMeta) &&
    !isStringColumn(colMeta)
  ) {
    throw new Error(
      `Aggregation "${sqlAgg}" requires a numeric, date or text column, but "${column}"${where} is ${describeColumnType(colMeta)}.`
    );
  }

  return sqlAgg;
}

function buildDateGroupExpression(column, grain, opts) {
  const col = quoteIdentifier(column);
  const fmt = resolveDateGrain(grain).format;
  const options = opts || {};

  if (options.isString) {
    const parseFormat = options.parseFormat;
    if (!parseFormat) {
      throw new Error(
        `Date column "${column}" has a string type. Provide its parse format in dataSource.dateParse (e.g. {"${column}": "%Y-%m-%d"}) or use a native DATE/DATETIME/TIMESTAMP column.`
      );
    }
    return `DATE_FORMAT(STR_TO_DATE(${col}, '${escapeLiteral(parseFormat)}'), '${fmt}')`;
  }

  return `DATE_FORMAT(${col}, '${fmt}')`;
}

function buildAggExpression(aggFn, column, alias) {
  const col = quoteIdentifier(column);
  const sqlAgg = resolveAggregation(aggFn);
  let expr;
  if (sqlAgg === 'COUNT_DISTINCT') {
    expr = `COUNT(DISTINCT ${col})`;
  } else {
    expr = `${sqlAgg}(${col})`;
  }
  return alias ? `${expr} AS ${quoteIdentifier(alias)}` : expr;
}

/**
 * Domain predicate for slicer/dimension value lists. The empty-string check only
 * applies to string columns: MySQL coerces '' to 0 when compared with a numeric
 * column, which would silently drop every legitimate 0 value.
 */
function buildNonEmptyCondition(column, colMeta) {
  const col = quoteIdentifier(column);
  const parts = [`${col} IS NOT NULL`];
  if (isStringColumn(colMeta)) parts.push(`${col} != ''`);
  return parts.join(' AND ');
}

function buildWhereSql(filters) {
  const conditions = [];
  const params = [];
  for (const f of filters || []) {
    const col = quoteIdentifier(f.column);
    const op = resolveOperator(f.operator || 'IN');

    if (op === 'IN') {
      const values = Array.isArray(f.values) ? f.values : [];
      if (!values.length) continue;
      const placeholders = values.map(() => '?').join(', ');
      conditions.push(`${col} IN (${placeholders})`);
      params.push(...values.map(String));
    } else if (op === 'BETWEEN') {
      const values = Array.isArray(f.values) ? f.values : [];
      if (values.length < 2) continue;
      conditions.push(`${col} BETWEEN ? AND ?`);
      params.push(String(values[0]), String(values[1]));
    } else {
      const values = Array.isArray(f.values) ? f.values : [];
      if (!values.length) continue;
      conditions.push(`${col} ${op} ?`);
      params.push(String(values[0]));
    }
  }
  return {
    where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

/**
 * Sort key for a date bucket. Strictly monotonic within a grain, so DAY / HOUR /
 * WEEK buckets can never collide the way a month-truncated key would.
 */
function parsePeriodKey(period, grain) {
  const raw = period == null ? '' : String(period);
  if (!raw) return 0;

  const resolved = grainForPeriod(raw, grain);
  if (resolved) {
    const match = resolved.pattern.exec(raw);
    if (match) {
      try {
        const key = resolved.sortKey(match);
        if (Number.isFinite(key)) return key;
      } catch (_) {
        /* fall through to generic parsing */
      }
    }
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Human label for a date bucket, driven by the grain rather than by an assumed
 * YYYY-MM shape. Falls back to the raw bucket value; never emits "undefined".
 */
function formatPeriodDisplay(period, grain) {
  if (period == null) return '';
  const raw = String(period);
  if (!raw) return '';

  const resolved = grainForPeriod(raw, grain);
  if (!resolved) return raw;

  const match = resolved.pattern.exec(raw);
  if (!match) return raw;

  try {
    const label = resolved.display(match);
    if (label == null) return raw;
    const text = String(label);
    return text && !text.includes('undefined') ? text : raw;
  } catch (_) {
    return raw;
  }
}

module.exports = {
  quoteIdentifier,
  resolveSortDirection,
  resolveDateGrain,
  validateAggregation,
  buildDateGroupExpression,
  buildAggExpression,
  buildNonEmptyCondition,
  buildWhereSql,
  parsePeriodKey,
  formatPeriodDisplay,
};
