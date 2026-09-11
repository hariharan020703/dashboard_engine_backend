const fs = require('fs');
const path = require('path');
const { DASHBOARD_CONFIG_DIR } = require('../config/env');

/**
 * Resolves a dashboardId to its dashboard JSON.
 *
 * Storage is deliberately plain files, no database — dashboard metadata is
 * runtime configuration, so it lives under backend/config/dashboards:
 *   config/dashboards/<dashboardId>.json   one file per dashboard
 *   config/dashboards/default.json         served when no id is supplied
 *
 * The Query Engine never sees a dashboard id: it only ever receives a resolved
 * spec object, so adding dashboards needs no engine change.
 */

const DASHBOARD_DIR = process.env.DASHBOARD_DIR
  ? path.resolve(process.env.DASHBOARD_DIR)
  : DASHBOARD_CONFIG_DIR;

const DEFAULT_SPEC_PATH = path.join(DASHBOARD_DIR, 'default.json');
const DEFAULT_DASHBOARD_ID = process.env.DEFAULT_DASHBOARD_ID || 'default';

// Ids become file names, so the allowlist is also the path-traversal guard.
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
  const spec = JSON.parse(raw.replace(/^﻿/, ''));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`Dashboard file ${path.basename(filePath)} does not contain a dashboard object`);
  }
  return spec;
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

/** Absolute path backing a dashboard id, or null when nothing backs it yet. */
function specPathFor(dashboardId) {
  const id = assertValidDashboardId(dashboardId);
  const registryPath = registryPathFor(id);
  if (fs.existsSync(registryPath)) return registryPath;
  if (fs.existsSync(DEFAULT_SPEC_PATH) && (id === DEFAULT_DASHBOARD_ID || id === defaultSpecId())) {
    return DEFAULT_SPEC_PATH;
  }
  return null;
}

function resolveSpec(dashboardId) {
  const id = assertValidDashboardId(dashboardId);
  const cached = specCache.get(id);
  if (cached) return cached;

  const filePath = specPathFor(id);
  if (!filePath) throw new DashboardNotFoundError(id);

  const spec = readSpecFile(filePath);
  specCache.set(id, spec);
  return spec;
}

/** The dashboard served when no id is supplied. */
function resolveDefaultSpec() {
  if (fs.existsSync(DEFAULT_SPEC_PATH)) {
    const cached = specCache.get(DEFAULT_DASHBOARD_ID);
    if (cached) return cached;
    const spec = readSpecFile(DEFAULT_SPEC_PATH);
    specCache.set(DEFAULT_DASHBOARD_ID, spec);
    return spec;
  }
  const first = listDashboards()[0];
  if (!first) throw new DashboardNotFoundError(DEFAULT_DASHBOARD_ID);
  return resolveSpec(first.id);
}

function defaultDashboardId() {
  return DEFAULT_DASHBOARD_ID;
}

function listDashboards() {
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
    entries.push({ id, title, source: 'registry' });
  }

  if (fs.existsSync(DEFAULT_SPEC_PATH)) {
    let spec = {};
    try {
      spec = readSpecFile(DEFAULT_SPEC_PATH);
    } catch (_) {
      spec = {};
    }
    // The default dashboard is also addressable by the id declared inside it.
    for (const id of [DEFAULT_DASHBOARD_ID, defaultSpecId()]) {
      if (!id || seen.has(id) || !DASHBOARD_ID_RE.test(id)) continue;
      seen.add(id);
      entries.push({ id, title: spec.title, source: 'alias' });
    }
  }

  return entries;
}

function saveSpec(dashboardId, spec) {
  const id = assertValidDashboardId(dashboardId);
  // Writes stay where the dashboard already lives; new ids land in the registry.
  let target = specPathFor(id);
  if (!target) {
    fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
    target = registryPathFor(id);
  }
  fs.writeFileSync(target, JSON.stringify(spec, null, 2) + '\n');
  invalidateSpecCache(id);
  return target;
}

function invalidateSpecCache(dashboardId) {
  if (dashboardId == null) {
    specCache.clear();
    return;
  }
  const id = String(dashboardId);
  specCache.delete(id);
  // The default file backs both the default id and its own declared id.
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
  invalidateSpecCache,
};
