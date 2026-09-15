const { resolveColumn } = require('../metadata/metadataResolver');
const { validateAggregation, resolveSortDirection, resolveDateGrain } = require('../semantic/semanticLayer');

function getColumn(meta, name) {
  return resolveColumn(meta.table, name);
}

function tableName(meta) {
  return meta && meta.table ? meta.table.table : undefined;
}

// Column identity is case-insensitive, matching metadata resolution.
function sameColumn(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function buildDateGroup(meta, column, grain) {
  const colMeta = getColumn(meta, column);
  // Fails fast on a grain the engine cannot actually bucket or label.
  const resolved = resolveDateGrain(grain);
  return {
    column,
    grain: resolved.key,
    isString: colMeta.isString,
    parseFormat: (meta.dateParse && meta.dateParse[column]) || null,
    columnMeta: colMeta,
  };
}

/**
 * Reads a date-grain declaration from any spec node that can carry one.
 * Shape: { column, dateTimeElement|grain }.
 */
function readDateGrainSpec(node) {
  const dg = node && node.dateGrain;
  if (!dg || typeof dg !== 'object') return null;
  const column = dg.column;
  const grain = dg.dateTimeElement || dg.grain || dg.element;
  if (!column || !grain) return null;
  return { column, grain };
}

function buildMeasure(meta, columnName, aggregation, alias) {
  const colMeta = getColumn(meta, columnName);
  // Resolves the aggregation AND checks it against the column's real DB type.
  const resolved = validateAggregation(aggregation || 'SUM', columnName, colMeta, tableName(meta));
  return {
    column: columnName,
    aggregation: resolved,
    alias,
    columnMeta: colMeta,
  };
}

function buildFilters(spec, filters, meta) {
  const list = [];
  if (!filters) return list;
  for (const s of spec.slicers || []) {
    const selected = filters[s.id];
    if (!selected || !selected.length) continue;
    const colMeta = getColumn(meta, s.column);
    list.push({
      column: s.column,
      operator: 'IN',
      values: selected.map(String),
      columnMeta: colMeta,
    });
  }
  return list;
}

function normalizeOrderBySpec(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((entry) => (typeof entry === 'string' ? { column: entry } : entry))
    .filter((entry) => entry && typeof entry === 'object');
}

/**
 * Turns card.orderBy / card.sort into validated sort terms. Every referenced
 * column is checked against database metadata, and every direction against an
 * allowlist, so nothing user-supplied reaches SQL unvalidated.
 */
function buildOrderBy(card, meta, measures, dimensions, dateGroup) {
  const entries = normalizeOrderBySpec(card.orderBy != null ? card.orderBy : (card.sort != null ? card.sort : card.sortBy));
  if (!entries.length) return [];

  return entries.map((entry) => {
    const column = entry.column || entry.field || entry.name;
    if (!column) {
      throw new Error('Invalid orderBy entry: expected a "column" (or "field") name');
    }
    const colMeta = getColumn(meta, column);
    const direction = resolveSortDirection(
      entry.direction != null ? entry.direction : (entry.dir != null ? entry.dir : entry.order)
    );

    // Sorting on the bucketed date column sorts on the bucket expression.
    if (dateGroup && sameColumn(column, dateGroup.column)) {
      return { column, direction, dateGroup };
    }

    const explicitAgg = entry.aggregation != null ? entry.aggregation : entry.agg;
    if (explicitAgg) {
      return {
        column,
        direction,
        aggregation: validateAggregation(explicitAgg, column, colMeta, tableName(meta)),
      };
    }

    const measure = measures.find((m) => sameColumn(m.column, column));
    if (measure) {
      return { column, direction, aggregation: measure.aggregation };
    }

    const isDimension = dimensions.some((d) => sameColumn(d.column, column));
    if (!isDimension && (dimensions.length || dateGroup)) {
      throw new Error(
        `orderBy column "${column}" must be one of the card's groupBy dimensions or measures, ` +
        'or must specify an "aggregation".'
      );
    }

    return { column, direction, aggregation: null };
  });
}

/** A card's fields, tolerating a legacy series.main body. */
function cardColumns(card) {
  return (card && (card.columns || card.series?.main?.columns)) || [];
}

/** The field a KPI reduces to a single number. */
function kpiValueColumn(kpi) {
  const columns = cardColumns(kpi);
  return columns.find((c) => c.mapping === 'VALUE') || columns[0] || null;
}

/**
 * The bucket a KPI compares across, or null when it has none — a KPI needs
 * both a comparison block and a date grain before it can show a delta.
 */
function readKpiPeriod(kpi) {
  if (!kpi || !kpi.comparison) return null;
  return readDateGrainSpec(kpi) || readDateGrainSpec(kpi.series?.main);
}

/**
 * A KPI renders a single aggregated value, so only its value column and its
 * comparison bucket reach the query. Sort, limit and the remaining field roles
 * are part of every card's spec but have no effect on a badge.
 */
function planKpi(kpi, filtersList, meta, specIndex) {
  const vCol = kpiValueColumn(kpi);
  if (!vCol) {
    throw new Error('KPI card has no value column: add a field with the "Value" role.');
  }

  const measure = buildMeasure(meta, vCol.column, vCol.aggregation, '_value');
  const period = readKpiPeriod(kpi);

  return {
    kind: period ? 'kpi-period' : 'kpi-simple',
    id: kpi.id,
    specIndex,
    kpi,
    source: meta.source,
    measures: [measure],
    dateGroup: period ? buildDateGroup(meta, period.column, period.grain) : null,
    orderBy: [],
    filters: filtersList,
    limit: null,
  };
}

function planCard(card, filtersList, meta, specIndex) {
  const columns = cardColumns(card);
  const valueCols = columns.filter((c) => c.mapping === 'VALUE');
  const xCol = columns.find((c) => ['XTIME', 'SERIES', 'ITEM'].includes(c.mapping));

  const groupByColumns = [];
  if (card.groupBy && card.groupBy.length) {
    for (const g of card.groupBy) {
      if (g.column) groupByColumns.push(g.column);
    }
  } else if (xCol) {
    groupByColumns.push(xCol.column);
  }

  const dateGrainSpec = readDateGrainSpec(card) || readDateGrainSpec(card.series?.main);
  const dateGroup = dateGrainSpec
    ? buildDateGroup(meta, dateGrainSpec.column, dateGrainSpec.grain)
    : null;

  const measures = valueCols.map((c) => buildMeasure(meta, c.column, c.aggregation, c.column));

  // A bucketed date column is grouped by its bucket expression, not its raw value.
  const dimensions = groupByColumns
    .filter((c) => !dateGroup || !sameColumn(c, dateGroup.column))
    .map((c) => ({ column: c, columnMeta: getColumn(meta, c) }));

  return {
    kind: 'card',
    id: card.id,
    specIndex,
    card,
    chartType: card.chartType,
    source: meta.source,
    measures,
    dimensions,
    dateGroup,
    orderBy: buildOrderBy(card, meta, measures, dimensions, dateGroup),
    limit: card.limits ? parseInt(card.limits, 10) : null,
    filters: filtersList,
  };
}

function planSlicer(slicer, meta, specIndex) {
  const colMeta = getColumn(meta, slicer.column);
  return {
    kind: 'slicer',
    id: slicer.id,
    specIndex,
    slicer,
    source: meta.source,
    column: slicer.column,
    columnMeta: colMeta,
  };
}

module.exports = {
  buildFilters,
  cardColumns,
  kpiValueColumn,
  readKpiPeriod,
  planKpi,
  planCard,
  planSlicer,
};
