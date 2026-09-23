const fs = require('fs');
const path = require('path');
const { db, T, withTransaction } = require('../config/database');
const { DASHBOARD_CONFIG_DIR } = require('../config/env');
const { normalizeSpec } = require('./cardModel');

/**
 * Resolves a dashboardId to its dashboard JSON.
 *
 * Dashboards are stored in the PostgreSQL `dashboards` table. For development
 * and backward compatibility, files in `config/dashboards/<dashboardId>.json`
 * serve as initial templates and fallbacks.
 */

const DASHBOARD_DIR = process.env.DASHBOARD_DIR
  ? path.resolve(process.env.DASHBOARD_DIR)
  : DASHBOARD_CONFIG_DIR;

const DEFAULT_SPEC_PATH = path.join(DASHBOARD_DIR, 'default.json');
const DEFAULT_DASHBOARD_ID = process.env.DEFAULT_DASHBOARD_ID || 'default';

// Ids become identifier strings, so the allowlist guards URL & path traversal.
const DASHBOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class InvalidDashboardIdError extends Error {
  constructor(dashboardId) {
    super(
      `Invalid dashboard id ${JSON.stringify(String(dashboardId))}. ` +
      'Allowed characters: letters, digits, underscore, hyphen (max 64).'
    );
    this.name = 'InvalidDashboardIdError';
    this.code = 'INVALID_DASHBOARD_ID';
  }
}

class DashboardNotFoundError extends Error {
  constructor(dashboardId) {
    super(`Dashboard not found: ${dashboardId}`);
    this.name = 'DashboardNotFoundError';
    this.code = 'DASHBOARD_NOT_FOUND';
  }
}

const specCache = new Map();

function assertValidDashboardId(dashboardId) {
  const id = String(dashboardId == null ? '' : dashboardId);
  if (!DASHBOARD_ID_RE.test(id)) throw new InvalidDashboardIdError(dashboardId);
  return id;
}

function readSpecFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const spec = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`Dashboard file ${path.basename(filePath)} does not contain a dashboard object`);
  }
  return normalizeSpec(spec);
}

function defaultSpecId() {
  if (!fs.existsSync(DEFAULT_SPEC_PATH)) return null;
  try {
    const spec = readSpecFile(DEFAULT_SPEC_PATH);
    return typeof spec.id === 'string' && spec.id.trim() ? spec.id.trim() : null;
  } catch (_) {
    return null;
  }
}

function registryPathFor(dashboardId) {
  return path.join(DASHBOARD_DIR, `${assertValidDashboardId(dashboardId)}.json`);
}

function specPathFor(dashboardId) {
  const id = assertValidDashboardId(dashboardId);
  const registryPath = registryPathFor(id);
  if (fs.existsSync(registryPath)) return registryPath;
  if (fs.existsSync(DEFAULT_SPEC_PATH) && (id === DEFAULT_DASHBOARD_ID || id === defaultSpecId())) {
    return DEFAULT_SPEC_PATH;
  }
  return null;
}

/** Resolves dashboard spec by id from DB or disk cache. */
async function resolveSpec(dashboardId) {
  const id = assertValidDashboardId(dashboardId);
  const cached = specCache.get(id);
  if (cached) return cached;

  // 1. Try DB first
  try {
    const { rows } = await db.query(
      `SELECT id, title, description, company_id, spec FROM ${T.dashboards} WHERE id = ?`,
      [id]
    );
    if (rows.length) {
      let spec = rows[0].spec;
      if (typeof spec === 'string') spec = JSON.parse(spec);
      spec = normalizeSpec(spec);
      if (!spec.id) spec.id = rows[0].id;
      if (!spec.title && rows[0].title) spec.title = rows[0].title;
      if (!spec.description && rows[0].description) spec.description = rows[0].description;
      spec.companyId = rows[0].company_id;
      specCache.set(id, spec);
      return spec;
    }
  } catch (err) {
    // If DB is initializing, continue to disk fallback
  }

  // 2. Fallback to file on disk
  const filePath = specPathFor(id);
  if (filePath) {
    const spec = readSpecFile(filePath);
    specCache.set(id, spec);
    return spec;
  }

  throw new DashboardNotFoundError(id);
}

/** The dashboard served when no id is supplied. */
async function resolveDefaultSpec() {
  if (specCache.has(DEFAULT_DASHBOARD_ID)) {
    return specCache.get(DEFAULT_DASHBOARD_ID);
  }

  try {
    return await resolveSpec(DEFAULT_DASHBOARD_ID);
  } catch (_) {
    const defId = defaultSpecId();
    if (defId) {
      try {
        return await resolveSpec(defId);
      } catch (_) {}
    }
    const all = await listDashboards();
    if (!all.length) throw new DashboardNotFoundError(DEFAULT_DASHBOARD_ID);
    return await resolveSpec(all[0].id);
  }
}

function defaultDashboardId() {
  return DEFAULT_DASHBOARD_ID;
}

function listDiskDashboards() {
  const entries = [];
  const seen = new Set();
  let files = [];
  try {
    files = fs.readdirSync(DASHBOARD_DIR);
  } catch (_) {
    files = [];
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = path.basename(file, '.json');
    if (!DASHBOARD_ID_RE.test(id) || seen.has(id)) continue;
    let title;
    try {
      title = readSpecFile(path.join(DASHBOARD_DIR, file)).title;
    } catch (_) {
      title = undefined;
    }
    seen.add(id);
    entries.push({ id, title, companyId: null, source: 'file' });
  }

  return entries;
}

/**
 * Lists all known dashboards from database + disk.
 *
 * If companyId is supplied (number), lists dashboards for that company plus
 * platform templates. If companyId is null, lists platform templates only.
 * If companyId is undefined, lists all dashboards (platform view).
 */
async function listDashboards(companyId = undefined) {
  const entries = [];
  const seen = new Set();

  try {
    let sql = `SELECT id, title, description, company_id AS "companyId", created_by AS "createdBy"
                 FROM ${T.dashboards}`;
    const params = [];
    if (companyId !== undefined) {
      if (companyId === null) {
        sql += ' WHERE company_id IS NULL';
      } else {
        sql += ' WHERE company_id = ? OR company_id IS NULL';
        params.push(companyId);
      }
    }
    sql += ' ORDER BY title ASC';

    const { rows } = await db.query(sql, params);
    for (const row of rows) {
      seen.add(row.id);
      entries.push({
        id: row.id,
        title: row.title,
        description: row.description,
        companyId: row.companyId,
        createdBy: row.createdBy,
        source: 'database',
      });
    }
  } catch (_) {
    // If DB is not yet ready, ignore and fall back to disk
  }

  const disk = listDiskDashboards();
  for (const d of disk) {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      entries.push(d);
    }
  }

  return entries;
}

/** Saves or updates a dashboard in the database and invalidates the cache. */
async function saveSpec(
  dashboardId,
  spec,
  { companyId = null, userId = null, title = null, description = null } = {}
) {
  const id = assertValidDashboardId(dashboardId);
  const normalized = normalizeSpec(spec);
  const resolvedTitle = title || normalized.title || id;
  const resolvedDesc = description !== undefined ? description : (normalized.description || null);

  await db.query(
    `INSERT INTO ${T.dashboards} (id, title, description, company_id, created_by, spec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, now())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       spec = EXCLUDED.spec,
       updated_at = now()`,
    [id, resolvedTitle, resolvedDesc, companyId, userId, JSON.stringify(normalized)]
  );

  invalidateSpecCache(id);
  return id;
}

/** Permanently deletes a dashboard from database, assignments, and grants. */
async function deleteDashboard(dashboardId) {
  const id = assertValidDashboardId(dashboardId);
  await withTransaction(async (conn) => {
    await conn.query(`DELETE FROM ${T.dashboardAccess} WHERE dashboard_id = ?`, [id]);
    await conn.query(`DELETE FROM ${T.groupDashboardAccess} WHERE dashboard_id = ?`, [id]);
    await conn.query(`DELETE FROM ${T.companyDashboards} WHERE dashboard_id = ?`, [id]);
    await conn.query(`DELETE FROM ${T.dashboards} WHERE id = ?`, [id]);
  });
  invalidateSpecCache(id);
}

function invalidateSpecCache(dashboardId) {
  if (dashboardId == null) {
    specCache.clear();
    return;
  }
  const id = String(dashboardId);
  specCache.delete(id);
  if (specPathFor(DEFAULT_DASHBOARD_ID) === DEFAULT_SPEC_PATH) {
    specCache.delete(DEFAULT_DASHBOARD_ID);
    const aliasId = defaultSpecId();
    if (aliasId) specCache.delete(aliasId);
  }
}

module.exports = {
  resolveSpec,
  resolveDefaultSpec,
  defaultDashboardId,
  listDashboards,
  saveSpec,
  deleteDashboard,
  invalidateSpecCache,
  assertValidDashboardId,
  DashboardNotFoundError,
};
