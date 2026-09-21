/**
 * Raised while reading configuration, and never caught.
 *
 * Every setting that decides who can sign in, what signs a token or where mail
 * goes is required outright: a default would be a fallback, and a fallback here
 * is a security hole that starts silently. A process that cannot be configured
 * correctly must not start at all, so these surface as a startup crash naming
 * the variable.
 */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** The value of a required variable, or a crash naming it and what it is for. */
function required(name, purpose) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`${name} is not set. It is required: ${purpose}`);
  }
  return value.trim();
}

/** An optional variable, or `fallback` — only ever used for non-secret settings. */
function optional(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** A required variable constrained to a fixed set of values. */
function oneOf(name, allowed, purpose) {
  const value = required(name, purpose);
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  }
  return value;
}

function integer(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  if (min !== undefined && value < min) throw new ConfigError(`${name} must be at least ${min}`);
  if (max !== undefined && value > max) throw new ConfigError(`${name} must be at most ${max}`);
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}"`);
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * A duration such as "15m" or "30d", returned in seconds.
 *
 * Token lifetimes are needed as a number in three places — the JWT claim, the
 * cookie's Max-Age and the database expiry — so they are parsed once here
 * rather than passed around as strings each consumer re-interprets.
 */
function duration(name, fallback) {
  const raw = optional(name, fallback);
  const match = DURATION_RE.exec(raw);
  if (!match) {
    throw new ConfigError(`${name} must be a duration like "15m", "12h" or "30d" (got "${raw}")`);
  }
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

module.exports = { ConfigError, required, optional, oneOf, integer, boolean, duration };
