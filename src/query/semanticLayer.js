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
 *   format   - PostgreSQL to_char pattern used to bucket rows
 *   pattern  - parses the bucket value that comes back from the database
 *   sortKey  - strictly monotonic within the grain, so buckets never collide
 *   display  - human label for the bucket
 * Adding a grain here is the only change needed to support it end to end.
 *
 * In a to_char pattern, double-quoted runs are literal text - that is what
 * `"W"` and `":00"` are doing, and why they are not mistaken for field codes.
 */
const DATE_GRAINS = {
  HOUR: {
    key: 'HOUR',
    format: 'YYYY-MM-DD HH24":00"',
    pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/,
    sortKey: (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
    display: (m) => `${monthName(m[2])} ${Number(m[3])}, ${m[1]} ${pad2(Number(m[4]))}:${m[5]}`,
  },
  DAY: {
    key: 'DAY',
    format: 'YYYY-MM-DD',
    pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    sortKey: (m) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    display: (m) => `${monthName(m[2])} ${Number(m[3])}, ${m[1]}`,
  },
  WEEK: {
    key: 'WEEK',
    // IYYY/IW are the ISO week-numbering year and week, so they always agree -
    // the plain YYYY would disagree with IW in the first and last days of a year.
    format: 'IYYY"-W"IW',
    pattern: /^(\d{4})-W(\d{1,2})$/,
    sortKey: (m) => Number(m[1]) * 100 + Number(m[2]),
    display: (m) => `W${pad2(Number(m[2]))} ${m[1]}`,
  },
  MONTH: {
    key: 'MONTH',
    format: 'YYYY-MM',
    pattern: /^(\d{4})-(\d{1,2})$/,
    sortKey: (m) => Number(m[1]) * 100 + Number(m[2]),
    display: (m) => `${monthName(m[2])} ${m[1]}`,
  },
  YEAR: {
    key: 'YEAR',
    format: 'YYYY',
    pattern: /^(\d{4})$/,
    sortKey: (m) => Number(m[1]),
    display: (m) => String(m[1]),
  },
};

// Most specific first so an HOUR bucket is never mistaken for a DAY bucket.
const GRAIN_INFERENCE_ORDER = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

/**
 * Double-quotes an identifier, escaping any embedded quote.
 *
 * Quoting is not optional: an unquoted identifier is folded to lower case, so
 * a real column called "Booking Date" is unreachable without quotes. Every
 * identifier this engine emits goes through here, and the name it quotes is the
 * exact one read from the catalogue.
 */
function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * The exact column name to put in SQL, taken from the catalogue rather than
 * from the dashboard JSON.
 *
 * PostgreSQL identifiers are case-sensitive once quoted, so a spec that says
 * "booking date" while the table has "Booking Date" must still emit the latter.
 * Resolution already happened during planning - this reads the answer, and
 * refuses rather than guessing if a plan node somehow arrived without one.
 */
function resolvedName(node) {
  const name = node && node.columnMeta && node.columnMeta.name;
  if (!name) {
    throw new Error(
      `Plan node for column "${node && node.column}" has no resolved metadata; ` +
      'it cannot be rendered safely.'
    );
  }
  return name;
}

/** schema-qualified table reference. */
function quoteQualified(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
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
 * so a mis-typed measure fails loudly rather than reaching the database.
 *
 * PostgreSQL would refuse `SUM(text)` itself, but as a query error naming a
 * function signature - "function sum(text) does not exist" - which says nothing
 * about which card is wrong. Checking here names the column and the dashboard.
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
        `Date column "${column}" has a string type. Provide its parse format in dataSource.dateParse ` +
        `(e.g. {"${column}": "DD-Mon-YY"}) or use a native DATE/TIMESTAMP column.`
      );
    }
    /*
     * A `%`-style strftime pattern is rejected rather than passed through.
     * `to_date(col, '%d-%b-%y')` does not fail - it matches those characters
     * literally and returns a nonsense date - so the mistake would show up as
     * every row bucketed into the wrong period rather than as an error.
     */
    if (parseFormat.includes('%')) {
      throw new Error(
        `dateParse for "${column}" uses the pattern "${parseFormat}", which is not a to_date ` +
        'template. Use one instead, e.g. "DD-Mon-YY" for 15-Aug-23, "YYYY-MM-DD" for 2023-08-15.'
      );
    }
    return `to_char(to_date(${col}, '${escapeLiteral(parseFormat)}'), '${fmt}')`;
  }

  return `to_char(${col}, '${fmt}')`;
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
 * Domain predicate for slicer/dimension value lists.
 *
 * The empty-string check applies only to string columns: comparing a numeric
 * column with '' is a type error, so applying it everywhere would turn a
 * perfectly good slicer into a failed query.
 */
function buildNonEmptyCondition(column, colMeta) {
  const col = quoteIdentifier(column);
  const parts = [`${col} IS NOT NULL`];
  if (isStringColumn(colMeta)) parts.push(`${col} <> ''`);
  return parts.join(' AND ');
}

function buildWhereSql(filters) {
  const conditions = [];
  const params = [];
  for (const f of filters || []) {
    const col = quoteIdentifier(resolvedName(f));
    const op = resolveOperator(f.operator || 'IN');

    /*
     * Values are bound as text and the column is cast to text to meet them.
     *
     * Slicer values arrive from a URL and are always strings, and comparing a
     * string to an integer column is refused outright - "operator does not
     * exist: integer = text". Casting the column makes the comparison explicit
     * and behave the same for every column type, at the cost of not using a
     * plain index on that column, which is why scripts/setupIndexes.js also
     * creates an expression index on the cast.
     */
    const cmp = isStringColumn(f.columnMeta) ? col : `${col}::text`;

    if (op === 'IN') {
      const values = Array.isArray(f.values) ? f.values : [];
      if (!values.length) continue;
      const placeholders = values.map(() => '?').join(', ');
      conditions.push(`${cmp} IN (${placeholders})`);
      params.push(...values.map(String));
    } else if (op === 'BETWEEN') {
      const values = Array.isArray(f.values) ? f.values : [];
      if (values.length < 2) continue;
      conditions.push(`${cmp} BETWEEN ? AND ?`);
      params.push(String(values[0]), String(values[1]));
    } else {
      const values = Array.isArray(f.values) ? f.values : [];
      if (!values.length) continue;
      conditions.push(`${cmp} ${op} ?`);
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
  quoteQualified,
  resolvedName,
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
