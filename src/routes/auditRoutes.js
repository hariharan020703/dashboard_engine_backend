const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { ok } = require('../api/response');
const { parseListQuery } = require('../api/listQuery');
const { AUDIT_FILE } = require('../auth/auditService');

/**
 * Audit log inspection for the platform owner.
 *
 * This router declares no guards of its own. It is mounted only inside
 * /api/platform, which already applies requireRbac, requireAuth,
 * requirePasswordCurrent and requirePlatform to everything below it - and it
 * used to carry a second, local copy of the platform check. Two guards enforcing
 * the same rule is how one of them gets relaxed later without the other, so the
 * mount is now the single place that decides who reaches this.
 *
 * Search, sort and paging happen HERE. The screen used to receive the newest
 * 200 entries and search, sort and page those in the browser - so a search
 * could never find anything older than the 200th entry, and every visit
 * shipped 200 entries to show 25. Now the whole trail is searchable and only
 * the visible page is sent.
 */
const router = express.Router();

/** The fields every entry has; the rest are "what changed". */
const ENVELOPE_KEYS = new Set(['ts', 'event', 'actor', 'actorId', 'actorCompanyId']);

/** A table cell shows one line, so the summary is capped; `detail` has it all. */
const SUMMARY_MAX = 240;

/**
 * Tone for an event, from what the event did rather than from a list of names,
 * so a new event type is categorised sensibly without this file changing. The
 * screen maps the category to colours; the categorisation itself is data.
 */
function toneFor(event) {
  const name = String(event).toLowerCase();
  if (name.includes('denied') || name.includes('fail') || name.includes('block')) return 'danger';
  if (name.includes('deleted') || name.includes('revoked') || name.includes('deactivated')) return 'warning';
  if (name.includes('created') || name.includes('granted') || name.includes('activated')) return 'success';
  return 'neutral';
}

/**
 * One entry, shaped for the audit table.
 *
 * `label` and `summary` are what the Event and Detail columns print; `detail`
 * is the non-envelope fields, for the inspect dialog. Absent actor fields are
 * omitted - a system event has no actor.
 */
function shapeEntry(entry) {
  const detail = {};
  const parts = [];
  for (const [key, value] of Object.entries(entry)) {
    if (ENVELOPE_KEYS.has(key) || value === null || value === undefined) continue;
    detail[key] = value;
    parts.push(`${key}: ${String(value)}`);
  }
  const summary = parts.join(' · ');
  const item = {
    ts: entry.ts,
    event: entry.event,
    label: String(entry.event || '').replace(/_/g, ' ').toLowerCase(),
    tone: toneFor(entry.event || ''),
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
    detail,
  };
  if (entry.actor !== null && entry.actor !== undefined) item.actor = entry.actor;
  if (entry.actorId !== null && entry.actorId !== undefined) item.actorId = entry.actorId;
  if (entry.actorCompanyId !== null && entry.actorCompanyId !== undefined) {
    item.actorCompanyId = entry.actorCompanyId;
  }
  return item;
}

/** The text a search matches: event, actor and every detail value. */
function searchText(item) {
  return `${item.event} ${item.actor ?? ''} ${Object.entries(item.detail)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')}`.toLowerCase();
}

const AUDIT_SORTS = { ts: 'ts', event: 'event', actor: 'actor' };

/** Every parseable entry in the file, oldest first, one at a time. */
async function* readEntries() {
  const rl = readline.createInterface({
    input: fs.createReadStream(AUDIT_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // A corrupted line is skipped, not fatal to the whole trail.
    }
  }
}

/*
 * GET /api/platform/audit
 *   ?page&pageSize&search&sort=ts|event|actor&dir&event=<EVENT_NAME>
 *   -> { items, total }
 *
 * The file is append-only, so it is already in time order. Sorted by time
 * (the default, newest first) only the requested window is kept while the file
 * streams past: memory is O(page x pageSize), not O(file). Sorting by event or
 * actor needs every match, so those collect the matches (never the whole file)
 * and sort them.
 */
router.get('/', async (req, res) => {
  const list = parseListQuery(req.query, AUDIT_SORTS, { sort: 'ts', dir: 'desc', pageSize: 25 });
  const eventFilter = typeof req.query.event === 'string' && req.query.event ? req.query.event : null;
  const needle = list.search.toLowerCase();

  if (!fs.existsSync(AUDIT_FILE)) return ok(res, { items: [], total: 0 });

  const matches = (item) => (!eventFilter || item.event === eventFilter) && (!needle || searchText(item).includes(needle));

  let total = 0;
  let items;

  if (list.sort === 'ts') {
    if (list.dir === 'asc') {
      // Oldest first: keep the matches whose position falls in the window.
      items = [];
      for await (const entry of readEntries()) {
        const item = shapeEntry(entry);
        if (!matches(item)) continue;
        if (total >= list.offset && items.length < list.pageSize) items.push(item);
        total += 1;
      }
    } else {
      // Newest first: the window is counted from the END, which is unknown
      // until the file ends, so keep a ring of the last offset+pageSize matches.
      const keep = list.offset + list.pageSize;
      const ring = new Array(keep);
      for await (const entry of readEntries()) {
        const item = shapeEntry(entry);
        if (!matches(item)) continue;
        ring[total % keep] = item;
        total += 1;
      }
      // Walk backwards from the newest match: position i from the end lives at
      // (total - 1 - i) mod keep, for as long as that match was retained.
      items = [];
      for (let i = list.offset; i < Math.min(keep, total); i += 1) {
        items.push(ring[(total - 1 - i) % keep]);
      }
    }
  } else {
    const all = [];
    for await (const entry of readEntries()) {
      const item = shapeEntry(entry);
      if (matches(item)) all.push(item);
    }
    total = all.length;
    const key = list.sort;
    const direction = list.dir === 'desc' ? -1 : 1;
    all.sort((a, b) => {
      const left = a[key];
      const right = b[key];
      if (left === right) return 0;
      if (left === undefined || left === null) return 1;
      if (right === undefined || right === null) return -1;
      return String(left).localeCompare(String(right)) * direction;
    });
    items = all.slice(list.offset, list.offset + list.pageSize);
  }

  ok(res, { items, total });
});

module.exports = router;
