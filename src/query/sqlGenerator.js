const {
  quoteIdentifier,
  quoteQualified,
  resolvedName,
  buildAggExpression,
  buildDateGroupExpression,
  buildNonEmptyCondition,
  buildWhereSql,
  resolveSortDirection,
} = require('./semanticLayer');

/**
 * Two names per column, and the difference matters on PostgreSQL.
 *
 * A column is REFERENCED by the exact name the catalogue holds, because quoted
 * identifiers are case-sensitive. It is ALIASED to the name the dashboard JSON
 * used, because that is the key query/resultFormatter.js reads out of the row.
 * Where the two agree the alias is a no-op; where they differ, emitting either
 * one alone breaks something.
 */
function ref(node) {
  return quoteIdentifier(resolvedName(node));
}

function alias(node) {
  return quoteIdentifier(node.column);
}

function tableRef(source) {
  return quoteQualified(source.schema, source.table);
}

function dateSelect(dateGroup) {
  return buildDateGroupExpression(resolvedName(dateGroup), dateGroup.grain, dateGroup);
}

/**
 * Renders one validated sort term.
 *
 * A bucketed date column is ordered by its SELECT alias, which PostgreSQL
 * resolves for a bare output-column name in ORDER BY. Every grain format is
 * zero-padded, so lexicographic order is chronological order.
 */
function orderTerm(term) {
  const direction = resolveSortDirection(term.direction);
  if (term.dateGroup) {
    // The bucket, not the raw value: this names the SELECT alias, which
    // PostgreSQL resolves in ORDER BY in preference to a like-named base column.
    return `${alias(term.dateGroup)} ${direction}`;
  }
  if (term.aggregation) {
    return `${buildAggExpression(term.aggregation, resolvedName(term))} ${direction}`;
  }
  return `${ref(term)} ${direction}`;
}

function generateKpiPeriodSql(plan) {
  const table = tableRef(plan.source);
  const { where, params } = buildWhereSql(plan.filters);

  if (plan.kind === 'kpi-period-merged') {
    const selects = [dateSelect(plan.dateGroup) + ' AS "_period"'];
    for (const member of plan.members) {
      selects.push(
        buildAggExpression(member.measure.aggregation, resolvedName(member.measure), member.alias)
      );
    }
    const sql = `SELECT ${selects.join(', ')} FROM ${table}${where} GROUP BY "_period" ORDER BY "_period" ASC`;
    return { sql, params, meta: { type: plan.kind, plan } };
  }

  const select = `${dateSelect(plan.dateGroup)} AS "_period", ${buildAggExpression(
    plan.measures[0].aggregation,
    resolvedName(plan.measures[0]),
    '_value'
  )}`;
  const sql = `SELECT ${select} FROM ${table}${where} GROUP BY "_period" ORDER BY "_period" ASC`;
  return { sql, params, meta: { type: plan.kind, plan } };
}

function generateKpiSimpleSql(plan) {
  const table = tableRef(plan.source);
  const { where, params } = buildWhereSql(plan.filters);
  const select = buildAggExpression(plan.measures[0].aggregation, resolvedName(plan.measures[0]), '_value');
  const sql = `SELECT ${select} FROM ${table}${where}`;
  return { sql, params, meta: { type: plan.kind, plan } };
}

function generateCardSql(plan) {
  const table = tableRef(plan.source);
  const { where, params } = buildWhereSql(plan.filters);

  const selectParts = [];
  const groupParts = [];

  if (plan.dateGroup) {
    const expr = dateSelect(plan.dateGroup);
    // Aliased to the source column name so the formatter can read it back by
    // its metadata name, and grouped by the expression rather than the alias -
    // an alias that shadows a real column would otherwise be ambiguous.
    selectParts.push(`${expr} AS ${alias(plan.dateGroup)}`);
    groupParts.push(expr);
  }

  for (const d of plan.dimensions) {
    selectParts.push(`${ref(d)} AS ${alias(d)}`);
    // Grouped by the reference, never the alias: an alias that shadows another
    // column would make GROUP BY ambiguous.
    groupParts.push(ref(d));
  }

  for (const m of plan.measures) {
    selectParts.push(buildAggExpression(m.aggregation, resolvedName(m), m.alias));
  }

  const groupBy = groupParts.length ? ' GROUP BY ' + groupParts.join(', ') : '';

  let orderBy = '';
  if (plan.orderBy && plan.orderBy.length) {
    orderBy = ' ORDER BY ' + plan.orderBy.map(orderTerm).join(', ');
  } else if (plan.dateGroup) {
    // Chronological is the only sensible default for a time series.
    orderBy = ` ORDER BY ${alias(plan.dateGroup)} ASC`;
  } else if (plan.measures.length && plan.dimensions.length) {
    const first = plan.measures[0];
    orderBy = ` ORDER BY ${buildAggExpression(first.aggregation, resolvedName(first))} DESC`;
  }

  const limit = plan.limit ? ` LIMIT ${plan.limit}` : ''; // plan.limit is a bounded integer (see planner)

  const sql = `SELECT ${selectParts.join(', ')} FROM ${table}${where}${groupBy}${orderBy}${limit}`;
  return { sql, params, meta: { type: plan.kind, plan } };
}

function generateSlicerSql(plan) {
  const col = ref(plan);
  const table = tableRef(plan.source);
  // Type-aware domain predicate: '' is only excluded for string columns.
  const condition = buildNonEmptyCondition(resolvedName(plan), plan.columnMeta);
  const sql =
    `SELECT ${col} AS "value", COUNT(*) AS "count" FROM ${table} ` +
    `WHERE ${condition} GROUP BY ${col} ORDER BY ${col} ASC`;
  return { sql, params: [], meta: { type: plan.kind, plan } };
}

function generateSql(plan) {
  switch (plan.kind) {
    case 'kpi-period-merged':
    case 'kpi-period':
      return generateKpiPeriodSql(plan);
    case 'kpi-simple':
      return generateKpiSimpleSql(plan);
    case 'card':
      return generateCardSql(plan);
    case 'slicer':
      return generateSlicerSql(plan);
    default:
      throw new Error(`Unknown plan kind: ${plan.kind}`);
  }
}

module.exports = {
  generateSql,
};
