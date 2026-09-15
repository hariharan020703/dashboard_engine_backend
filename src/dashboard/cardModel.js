/**
 * The shape of a dashboard card, shared by the registry, the API and the
 * query layer.
 *
 * A dashboard declares ONE ordered list of cards. What a card *is* — a KPI
 * badge or a chart — is read off its chartType, so changing the type is all it
 * takes to turn one into the other, and every card is edited with the same set
 * of options.
 */

// Aliases recognised in dashboard JSON; the first is what the editor writes.
const KPI_CHART_TYPES = ['badge_multi_value', 'badge', 'kpi', 'scorecard'];
const KPI_TYPE_SET = new Set(KPI_CHART_TYPES);

/** Fields a card carries directly, historically nested under series.main. */
const SERIES_FIELDS = ['columns', 'dateGrain', 'groupBy', 'orderBy', 'filters', 'distinct'];

function isKpiChartType(chartType) {
  return KPI_TYPE_SET.has(String(chartType == null ? '' : chartType).trim().toLowerCase());
}

/** 'kpi' or 'chart', decided by the card's chartType and nothing else. */
function cardKind(card) {
  return isKpiChartType(card && card.chartType) ? 'kpi' : 'chart';
}

/**
 * Lifts a legacy card body onto the flat shape everything else reads:
 * series.main.{columns,dateGrain,…} become top-level card fields. Cards that
 * are already flat are returned unchanged.
 */
function flattenCard(card) {
  if (!card || typeof card !== 'object') return card;
  const main = card.series && card.series.main;
  if (!main) return card;

  const next = { ...card };
  for (const field of SERIES_FIELDS) {
    if (next[field] == null && main[field] != null) next[field] = main[field];
  }
  if (next.limits == null && main.limit != null) next.limits = main.limit;
  delete next.series;
  return next;
}

/**
 * Normalises a dashboard read from disk. Older files that still declare a
 * separate `kpis` array keep working: their entries are prepended to `cards`,
 * which is where they rendered anyway.
 */
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const legacyKpis = Array.isArray(spec.kpis) ? spec.kpis : [];
  const cards = Array.isArray(spec.cards) ? spec.cards : [];
  const next = { ...spec, cards: [...legacyKpis, ...cards].map(flattenCard) };
  delete next.kpis;
  return next;
}

module.exports = {
  KPI_CHART_TYPES,
  isKpiChartType,
  cardKind,
  flattenCard,
  normalizeSpec,
};
