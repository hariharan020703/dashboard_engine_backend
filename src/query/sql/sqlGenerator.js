const {
  quoteIdentifier,
  buildAggExpression,
  buildDateGroupExpression,
  buildNonEmptyCondition,
  buildWhereSql,
  resolveSortDirection,
} = require('../semantic/semanticLayer');

function tableRef(source) {
  return quoteIdentifier(source.table);
}

function dateSelect(dateGroup) {
  return buildDateGroupExpression(dateGroup.column, dateGroup.grain, dateGroup);
}

/**
 * Renders one validated sort term.
 *
 * A bucketed date column is ordered by its SELECT alias: MySQL resolves ORDER BY
 * against select aliases before base columns, and every grain format is
 * zero-padded so lexicographic order is chronological order.
 */
function orderTerm(term) {
  const direction = resolveSortDirection(term.direction);
  if (term.dateGroup) {
    return `${quoteIdentifier(term.dateGroup.column)} ${direction}`;
  }
  if (term.aggregation) {
    return `${buildAggExpression(term.aggregation, term.column)} ${direction}`;
  }
  return `${quoteIdentifier(term.column)} ${direction}`;
}

function generateKpiPeriodSql(plan) {
  const table = tableRef(plan.source);
  const { where, params } = buildWhereSql(plan.filters);

  if (plan.kind === 'kpi-period-merged') {
    const selects = [dateSelect(plan.dateGroup) + ' AS `_period`'];
    for (const member of plan.members) {
      selects.push(buildAggExpression(member.measure.aggregation, member.measure.column, member.alias));
    }
    const sql = `SELECT ${selects.join(', ')} FROM ${table}${where} GROUP BY \`_period\` ORDER BY \`_period\` ASC`;
    return { sql, params, meta: { type: plan.kind, plan } };
  }

  const select = `${dateSelect(plan.dateGroup)} AS \`_period\`, ${buildAggExpression(
    plan.measures[0].aggregation,
    plan.measures[0].column,
    '_value'
  )}`;
  const sql = `SELECT ${select} FROM ${table}${where} GROUP BY \`_period\` ORDER BY \`_period\` ASC`;
  return { sql, params, meta: { type: plan.kind, plan } };
}

function generateKpiSimpleSql(plan) {
  const table = tableRef(plan.source);
  const { where, params } = buildWhereSql(plan.filters);
  const select = buildAggExpression(plan.measures[0].aggregation, plan.measures[0].column, '_value');
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
    // its metadata name; grouped by the expression, which MySQL resolves
    // against base columns before select aliases.
    selectParts.push(`${expr} AS ${quoteIdentifier(plan.dateGroup.column)}`);
    groupParts.push(expr);
  }

  for (const d of plan.dimensions) {
    selectParts.push(quoteIdentifier(d.column));
    groupParts.push(quoteIdentifier(d.column));
  }

  for (const m of plan.measures) {
    selectParts.push(buildAggExpression(m.aggregation, m.column, m.alias));
  }

  const groupBy = groupParts.length ? ' GROUP BY ' + groupParts.join(', ') : '';

  let orderBy = '';
  if (plan.orderBy && plan.orderBy.length) {
    orderBy = ' ORDER BY ' + plan.orderBy.map(orderTerm).join(', ');
  } else if (plan.dateGroup) {
    // Chronological is the only sensible default for a time series.
    orderBy = ` ORDER BY ${quoteIdentifier(plan.dateGroup.column)} ASC`;
  } else if (plan.measures.length && plan.dimensions.length) {
    const first = plan.measures[0];
    orderBy = ` ORDER BY ${buildAggExpression(first.aggregation, first.column)} DESC`;
  }

  const limit = plan.limit ? ` LIMIT ${plan.limit}` : ''; // plan.limit is a bounded integer (see planner)

  const sql = `SELECT ${selectParts.join(', ')} FROM ${table}${where}${groupBy}${orderBy}${limit}`;
  return { sql, params, meta: { type: plan.kind, plan } };
}

function generateSlicerSql(plan) {
  const col = quoteIdentifier(plan.column);
  const table = tableRef(plan.source);
  // Type-aware domain predicate: '' is only excluded for string columns.
  const condition = buildNonEmptyCondition(plan.column, plan.columnMeta);
  const sql =
    `SELECT ${col} AS \`value\`, COUNT(*) AS \`count\` FROM ${table} ` +
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
