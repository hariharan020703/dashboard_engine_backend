const { formatPeriodDisplay, parsePeriodKey } = require('../semantic/semanticLayer');

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

function formatValue(value, format) {
  const f = format || {};
  const prefix = f.prefix ?? '';
  const suffix = f.suffix ?? '';
  const abbr = f.type === 'abbreviated' || f.format === '#A';
  const rendered = abbr
    ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    : value.toLocaleString('en-US', { minimumFractionDigits: f.digits ?? 0, maximumFractionDigits: f.digits ?? 0 });
  return `${prefix}${rendered}${suffix}`;
}

function periodRows(rows, grain) {
  return rows
    .map((r) => ({
      _period: r._period,
      _value: Number(r._value) || 0,
    }))
    .sort((a, b) => parsePeriodKey(a._period, grain) - parsePeriodKey(b._period, grain));
}

function computeComparisonResult(rows, valueDisplay, grain) {
  const sorted = periodRows(rows, grain);
  if (!sorted.length) return { delta: 0, current: 0, previous: undefined, bucket: undefined, prevBucket: undefined };

  const last = sorted[sorted.length - 1];
  const prevBucket = sorted.length > 1 ? sorted[sorted.length - 2] : undefined;

  const cur = Number(last._value) || 0;
  const prev = prevBucket ? Number(prevBucket._value) || 0 : undefined;

  let delta;
  if ((valueDisplay || 'percent') === 'percent') {
    delta = prev !== undefined && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : cur !== 0 ? 100 : 0;
  } else {
    delta = prev !== undefined ? cur - prev : 0;
  }
  if (!Number.isFinite(delta)) delta = 0;

  return {
    delta,
    current: cur,
    previous: prev,
    bucket: last ? { name: formatPeriodDisplay(String(last._period), grain) } : undefined,
    prevBucket: prevBucket ? { name: formatPeriodDisplay(String(prevBucket._period), grain) } : undefined,
  };
}

function formatKpi(kpiSpec, rows) {
  if (!rows) return null;
  const columns = kpiSpec.series?.main?.columns || kpiSpec.columns || [];
  const vCol = columns.find((c) => c.mapping === 'VALUE') || columns[0];
  if (!vCol) return null;

  const itemCol = kpiSpec.series?.main?.dateGrain?.column
    || kpiSpec.series?.main?.groupBy?.[0]?.column
    || kpiSpec.groupBy?.[0]?.column
    || '';
  const grain = kpiSpec.series?.main?.dateGrain?.dateTimeElement || '';

  const hasComparison = kpiSpec.comparison && itemCol && grain;

  let comparisonResult;
  let value;

  if (hasComparison) {
    comparisonResult = computeComparisonResult(
      rows,
      String(kpiSpec.comparison?.comp_val_displayed || '').toLowerCase().includes('absolute')
        ? 'absolute'
        : 'percent',
      grain
    );
    value = comparisonResult.current;
  } else {
    value = rows[0] && rows[0]._value != null ? Number(rows[0]._value) || 0 : 0;
  }

  const text = formatValue(value, vCol.format || {});
  const previousText = comparisonResult?.prevBucket
    ? formatValue(comparisonResult.previous ?? 0, vCol.format || {})
    : '';

  return {
    id: kpiSpec.id,
    title: kpiSpec.title || kpiSpec.name,
    value,
    text,
    format: vCol.format || {},
    comparison: {
      label: kpiSpec.comparison?.label || '',
      delta: comparisonResult?.delta ?? 0,
      deltaText: comparisonResult?.delta != null
        ? Math.abs(comparisonResult.delta).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + (kpiSpec.comparison?.deltaFormat?.suffix ?? '')
        : '',
      previousText,
      period: comparisonResult?.bucket?.name || '',
      previousPeriod: comparisonResult?.prevBucket?.name || '',
    },
    spec: kpiSpec,
  };
}

function formatMergedKpi(member, rows) {
  if (!rows) return null;
  const colKey = `${member.id}__value`;
  const mapped = rows.map((r) => ({
    _period: r._period,
    _value: r[colKey],
  }));
  return formatKpi(member.kpi, mapped);
}

/**
 * True when the dashboard JSON declares its own sort order. Formatters that
 * apply a default ordering must not override an explicit one.
 */
function hasExplicitOrder(card) {
  const raw = card.orderBy != null ? card.orderBy : (card.sort != null ? card.sort : card.sortBy);
  if (raw == null) return false;
  return Array.isArray(raw) ? raw.length > 0 : true;
}

function colorFor(card, key, i) {
  const mapping = card.options?.colorMapping || {};
  if (mapping[key]) return mapping[key];
  if (card.options?.color && i === 0) return card.options.color;
  return PALETTE[i % PALETTE.length];
}

function formatCard(cardSpec, rows, minHeight) {
  if (!rows) return null;
  switch (cardSpec.chartType) {
    case 'line_bar_combo':
    case 'bar_line_combo':
    case 'combo':
      return formatCombo(cardSpec, rows, minHeight);
    case 'treemap':
    case 'tree_map':
    case 'hierarchy':
      return formatTreemap(cardSpec, rows, minHeight);
    case 'funnel':
    case 'conversion':
      return formatFunnel(cardSpec, rows, minHeight);
    case 'stacked_area':
    case 'area':
    case 'area_chart':
      return formatArea(cardSpec, rows, minHeight);
    default:
      return {
        id: cardSpec.id,
        chartType: cardSpec.chartType,
        title: cardSpec.title || cardSpec.name,
        description: cardSpec.description,
        data: [],
        axes: { x: { key: 'label', type: 'category' }, y: { key: 'value', type: 'number' } },
        series: [],
        options: { ...(cardSpec.options || {}), height: minHeight },
      };
  }
}

function formatCombo(card, rows, minHeight) {
  const columns = card.columns || [];
  const valueCols = columns.filter((c) => c.mapping === 'VALUE');
  const xCol = columns.find((c) => c.mapping === 'XTIME') || columns.find((c) => c.mapping === 'ITEM');
  const gKey = card.groupBy?.[0]?.column || xCol?.column || 'label';
  const dualAxis = card.options?.dualAxis === true;
  const half = Math.ceil(valueCols.length / 2);

  const data = rows.map((r) => {
    const point = { [gKey]: r[gKey] ?? r.label ?? '', label: r[gKey] ?? r.label ?? '' };
    for (const c of valueCols) {
      point[c.column] = Number(r[c.column]) || 0;
    }
    return point;
  });

  const series = valueCols.map((c, i) => ({
    key: c.column,
    name: c.alias || c.column,
    kind: dualAxis && i >= half ? 'line' : 'bar',
    axis: dualAxis && i >= half ? 'y2' : 'y1',
    color: colorFor(card, c.column, i),
  }));

  const axes = {
    x: { key: gKey, type: 'category' },
    y: { key: 'y1', type: 'number' },
    ...(dualAxis ? { y2: { key: 'y2', type: 'number' } } : {}),
  };

  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    data,
    axes,
    series,
    options: { ...(card.options || {}), height: minHeight },
  };
}

function formatArea(card, rows, minHeight) {
  const columns = card.columns || [];
  const xCol = columns.find((c) => c.mapping === 'XTIME') || columns.find((c) => c.mapping === 'ITEM');
  const seriesCol = columns.find((c) => c.mapping === 'SERIES');
  const valueCol = columns.find((c) => c.mapping === 'VALUE');
  const xKey = xCol?.column || 'label';
  const seriesName = seriesCol?.column || 'Series';
  const valueName = valueCol?.column || 'Value';
  const stacked = card.options?.stacked === true;

  const allSeries = Array.from(new Set(rows.map((r) => String(r[seriesName] ?? 'N/A'))));

  const dataMap = {};
  for (const r of rows) {
    const label = String(r[xKey] ?? 'N/A');
    if (!dataMap[label]) {
      dataMap[label] = { [xKey]: label, label };
    }
    dataMap[label][String(r[seriesName] ?? 'N/A')] = Number(r[valueName]) || 0;
  }

  const data = Object.values(dataMap).map((point) => {
    for (const s of allSeries) {
      if (point[s] === undefined) point[s] = 0;
    }
    return point;
  });

  const series = allSeries.map((s, i) => ({
    key: s,
    name: s,
    kind: 'area',
    color: colorFor(card, s, i),
    stackId: stacked ? s : undefined,
    fillOpacity: 0.35,
  }));

  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    data,
    axes: { x: { key: xKey, type: 'category' }, y: { key: 'value', type: 'number' } },
    series,
    options: { ...(card.options || {}), height: minHeight },
  };
}

function formatTreemap(card, rows, minHeight) {
  const columns = card.columns || [];
  const nameCol = columns.find((c) => c.mapping === 'SERIES') || columns.find((c) => c.mapping === 'XTIME') || columns.find((c) => c.mapping === 'ITEM');
  const valueCol = columns.find((c) => c.mapping === 'VALUE');
  const nameKey = nameCol?.column || card.groupBy?.[0]?.column || 'name';
  const valueKey = valueCol?.column || 'value';

  const points = rows.map((r) => ({
    name: String(r[nameKey] ?? r.name ?? ''),
    value: Number(r[valueKey]) || 0,
  }));
  // Largest-first by default, but an explicit orderBy in the JSON wins.
  const data = hasExplicitOrder(card) ? points : points.sort((a, b) => b.value - a.value);

  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    data,
    axes: { x: { key: nameKey, type: 'category' }, y: { key: 'value', type: 'number' } },
    series: [],
    options: { ...(card.options || {}), height: minHeight },
  };
}

function formatFunnel(card, rows, minHeight) {
  const columns = card.columns || [];
  const nameCol = columns.find((c) => c.mapping === 'SERIES') || columns.find((c) => c.mapping === 'ITEM') || columns.find((c) => c.mapping === 'XTIME');
  const valueCol = columns.find((c) => c.mapping === 'VALUE');
  const nameKey = nameCol?.column || card.groupBy?.[0]?.column || 'name';
  const valueKey = valueCol?.column || 'value';

  const points = rows.map((r) => ({
    name: String(r[nameKey] ?? r.name ?? ''),
    value: Number(r[valueKey]) || 0,
  }));
  // Funnels read largest-first by default; an explicit orderBy in the JSON wins.
  const data = hasExplicitOrder(card) ? points : points.sort((a, b) => b.value - a.value);

  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    data,
    axes: { y: { key: nameKey, type: 'category' } },
    series: [],
    options: { ...(card.options || {}), height: minHeight },
  };
}

function formatSlicer(slicerSpec, rows, filters) {
  const values = rows || [];
  const selSet = new Set(filters?.[slicerSpec.id] || []);
  return {
    id: slicerSpec.id,
    title: slicerSpec.title,
    column: slicerSpec.column,
    type: slicerSpec.type || 'multi',
    span: slicerSpec.span,
    showCount: slicerSpec.showCount,
    options: values.map((v) => ({ value: String(v.value), count: Number(v.count) || 0, selected: selSet.has(String(v.value)) })),
  };
}

module.exports = {
  formatKpi,
  formatMergedKpi,
  formatCard,
  formatSlicer,
  formatPeriodDisplay,
  parsePeriodKey,
};