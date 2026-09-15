require('../config/env');
const pool = require('../config/database');
const { executeQuery } = require('./execution/queryExecutor');
const QueryCache = require('../cache/queryCache');
const { buildFilters, planKpi, planCard, planSlicer } = require('./planning/queryPlanner');
const { optimizePlans } = require('./optimization/queryOptimizer');
const { generateSql } = require('./sql/sqlGenerator');
const { resolveSourceMetadata } = require('./metadata/metadataResolver');
const { formatKpi, formatMergedKpi, formatCard, formatSlicer } = require('./formatting/resultFormatter');
const { cardKind } = require('../dashboard/cardModel');

const cache = new QueryCache(process.env.REDIS_URL, {
  ttl: parseInt(process.env.REDIS_TTL || '300', 10),
  prefix: process.env.CACHE_PREFIX || 'bi',
});

const MAX_CONCURRENT = parseInt(process.env.QUERY_CONCURRENCY || '6', 10);

class FilterResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilterResolutionError';
    this.code = 'INVALID_FILTER';
  }
}

function dashboardKey(spec, meta) {
  return (
    spec.id ||
    spec.title ||
    (meta && meta.source ? `${meta.source.database}.${meta.source.table}` : 'default')
  );
}

function describeError(err, stage) {
  return {
    stage,
    message: err && err.message ? err.message : String(err),
  };
}

async function runQueryWithCache(query, dashKey, ttl) {
  const key = cache.generateKey(dashKey, query.meta.type, query.sql, query.params);
  const cached = await cache.get(key);
  if (cached) {
    return { rows: cached, cached: true, elapsed: 0 };
  }
  const { rows, elapsed } = await executeQuery(pool, query.sql, query.params);
  await cache.set(key, rows, ttl);
  return { rows, cached: false, elapsed };
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array(Math.min(limit, tasks.length))
    .fill(null)
    .map(async () => {
      while (next < tasks.length) {
        const i = next;
        next += 1;
        results[i] = await tasks[i]();
      }
    });
  await Promise.all(workers);
  return results;
}

function kpiErrorPayload(entry) {
  const card = entry.card || {};
  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    value: 0,
    text: '',
    format: {},
    color: null,
    // Kept as a full object so consumers can read comparison fields unconditionally.
    comparison: { label: '', delta: 0, deltaText: '', previousText: '', period: '', previousPeriod: '' },
    error: entry.error,
    spec: card,
  };
}

function chartErrorPayload(entry, minHeight) {
  const card = entry.card || {};
  return {
    id: card.id,
    chartType: card.chartType,
    title: card.title || card.name,
    description: card.description,
    data: [],
    axes: {},
    series: [],
    options: { ...(card.options || {}), height: minHeight },
    error: entry.error,
    spec: card,
  };
}

/** The placeholder a card renders as when it could not be planned or executed. */
function errorPayloadFor(entry, minHeight) {
  return entry.kind === 'kpi' ? kpiErrorPayload(entry) : chartErrorPayload(entry, minHeight);
}

function slicerErrorPayload(entry) {
  const slicer = entry.slicer || {};
  return {
    id: slicer.id,
    title: slicer.title,
    column: slicer.column,
    type: slicer.type || 'multi',
    span: slicer.span,
    showCount: slicer.showCount,
    options: [],
    error: entry.error,
  };
}

/**
 * Plans every card. A card's chartType picks its planner, and the resulting
 * kind is kept on the entry so formatting and error payloads never re-derive it.
 */
function planCardEntries(cards, filtersList, meta) {
  return (cards || []).map((card, specIndex) => {
    const kind = cardKind(card);
    const entry = { specIndex, card, kind };
    try {
      entry.plan = kind === 'kpi'
        ? planKpi(card, filtersList, meta, specIndex)
        : planCard(card, filtersList, meta, specIndex);
    } catch (err) {
      entry.error = describeError(err, 'plan');
    }
    return entry;
  });
}

function planSlicerEntries(slicers, meta) {
  return (slicers || []).map((slicer, specIndex) => {
    const entry = { specIndex, slicer };
    try {
      entry.plan = planSlicer(slicer, meta, specIndex);
    } catch (err) {
      entry.error = describeError(err, 'plan');
    }
    return entry;
  });
}

/**
 * Executes a dashboard spec.
 *
 * A dashboard is one ordered list of cards, and each card's chartType decides
 * whether it is planned as a KPI badge or as a chart. Cards and slicers are
 * planned, executed and formatted in isolation: a single invalid visual is
 * reported as error metadata on that visual instead of failing the whole
 * dashboard. Filter resolution is the one request-level failure, because an
 * unapplied filter would silently misstate every visual.
 */
async function hydrateDashboard(spec, filters) {
  const meta = await resolveSourceMetadata(spec);

  let filtersList;
  try {
    filtersList = buildFilters(spec, filters || {}, meta);
  } catch (err) {
    throw new FilterResolutionError(err.message);
  }

  const cardEntries = planCardEntries(spec.cards, filtersList, meta);
  const slicerEntries = planSlicerEntries(spec.slicers, meta);

  const cardByIndex = new Map(cardEntries.map((e) => [e.specIndex, e]));

  // Only KPI plans are mergeable: several badges sharing a table, grain and
  // filters collapse into one grouped query.
  const periodPlans = [];
  const simplePlans = [];
  for (const entry of cardEntries) {
    if (!entry.plan || entry.kind !== 'kpi') continue;
    if (entry.plan.kind === 'kpi-period') periodPlans.push(entry.plan);
    else simplePlans.push(entry.plan);
  }
  const { optimizedKpiPlans } = optimizePlans({ periodPlans, simplePlans });

  const kpiEntriesForPlan = (plan) =>
    (plan.kind === 'kpi-period-merged'
      ? plan.members.map((m) => cardByIndex.get(m.specIndex))
      : [cardByIndex.get(plan.specIndex)]
    ).filter(Boolean);

  const jobs = [];
  for (const plan of optimizedKpiPlans) jobs.push({ type: 'kpi', plan });
  for (const entry of cardEntries) {
    if (entry.kind === 'chart' && entry.plan) jobs.push({ type: 'chart', entry, plan: entry.plan });
  }
  for (const entry of slicerEntries) if (entry.plan) jobs.push({ type: 'slicer', entry, plan: entry.plan });

  const assignJobError = (job, error) => {
    if (job.type === 'kpi') {
      for (const entry of kpiEntriesForPlan(job.plan)) {
        if (!entry.error) entry.error = error;
      }
    } else if (!job.entry.error) {
      job.entry.error = error;
    }
  };

  // SQL generation can fail per visual (e.g. a string date column with no parse format).
  const runnable = [];
  for (const job of jobs) {
    try {
      job.query = generateSql(job.plan);
      runnable.push(job);
    } catch (err) {
      assignJobError(job, describeError(err, 'sql'));
    }
  }

  const dashKey = dashboardKey(spec, meta);
  const results = await runWithConcurrency(
    runnable.map((job) => () =>
      runQueryWithCache(job.query, dashKey)
        .then((r) => ({ ok: true, ...r }))
        .catch((err) => ({ ok: false, error: describeError(err, 'execute') }))
    ),
    MAX_CONCURRENT
  );
  runnable.forEach((job, i) => { job.result = results[i]; });

  const minHeight = spec.layout?.chart?.minHeight ?? 360;

  for (const job of runnable) {
    if (!job.result || !job.result.ok) {
      assignJobError(job, (job.result && job.result.error) || describeError(new Error('Query produced no result'), 'execute'));
      continue;
    }
    const rows = job.result.rows;

    if (job.type === 'kpi') {
      if (job.plan.kind === 'kpi-period-merged') {
        for (const member of job.plan.members) {
          const entry = cardByIndex.get(member.specIndex);
          if (!entry) continue;
          try {
            entry.formatted = formatMergedKpi(member, rows);
          } catch (err) {
            entry.error = describeError(err, 'format');
          }
        }
      } else {
        const entry = cardByIndex.get(job.plan.specIndex);
        if (entry) {
          try {
            entry.formatted = formatKpi(job.plan.kpi, rows);
          } catch (err) {
            entry.error = describeError(err, 'format');
          }
        }
      }
    } else if (job.type === 'chart') {
      try {
        const formatted = formatCard(job.entry.card, rows, minHeight);
        job.entry.formatted = formatted ? { ...formatted, spec: job.entry.card } : null;
      } catch (err) {
        job.entry.error = describeError(err, 'format');
      }
    } else {
      try {
        job.entry.formatted = formatSlicer(job.entry.slicer, rows, filters);
      } catch (err) {
        job.entry.error = describeError(err, 'format');
      }
    }
  }

  // Declaration order from the dashboard JSON is authoritative for both lists.
  const errors = [];
  const collect = (entries, key, errorPayload) =>
    entries
      .map((entry) => {
        if (entry.error) {
          errors.push({ kind: entry.kind || key, id: entry[key]?.id, ...entry.error });
          return errorPayload(entry);
        }
        return entry.formatted || null;
      })
      .filter(Boolean);

  const cards = collect(cardEntries, 'card', (e) => errorPayloadFor(e, minHeight));
  const slicers = collect(slicerEntries, 'slicer', slicerErrorPayload);

  const countJobs = (type) => runnable.filter((j) => j.type === type).length;

  return {
    cards,
    slicers,
    errors,
    _stats: {
      kpiQueries: countJobs('kpi'),
      cardQueries: countJobs('chart'),
      slicerQueries: countJobs('slicer'),
      totalQueries: runnable.length,
      cacheHits: results.filter((r) => r && r.cached).length,
      errors: errors.length,
    },
  };
}

module.exports = { hydrateDashboard, cache, FilterResolutionError };
