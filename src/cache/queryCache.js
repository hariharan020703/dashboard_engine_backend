const crypto = require('crypto');

class QueryCache {
  constructor(redisUrl, options) {
    this.redis = null;
    this.redisEnabled = false;
    this.ttl = (options && options.ttl) || 300;
    this.prefix = (options && options.prefix) || 'bi';

    this.memStore = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();

    if (!redisUrl) {
      console.log('[QueryCache] No Redis URL provided, using in-memory cache');
      return;
    }

    try {
      const Redis = require('ioredis');
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
        retryStrategy(times) {
          if (times > 1) return null;
          return 500;
        },
      });

      this.redis.on('connect', () => {
        this.redisEnabled = true;
        console.log('[QueryCache] Redis connected');
      });

      this.redis.on('error', (err) => {
        if (this.redisEnabled) {
          console.log('[QueryCache] Redis error, falling back to in-memory:', err.message);
        }
        this.redisEnabled = false;
      });

      this.redis.on('close', () => {
        this.redisEnabled = false;
      });

      this.redis.connect().catch(() => {
        console.log('[QueryCache] Redis unavailable, using in-memory cache');
      });
    } catch (err) {
      console.log('[QueryCache] Redis module not available, using in-memory cache:', err.message);
    }
  }

  _hash(value) {
    // 24 hex chars (96 bits) — wide enough that collisions are not a concern
    // even across a shared keyspace.
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  }

  // Keeps the dashboard namespace readable while guaranteeing it cannot inject
  // key separators or glob characters.
  _namespace(dashboardKey) {
    const raw = String(dashboardKey == null || dashboardKey === '' ? 'default' : dashboardKey);
    const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64);
    return safe === raw ? safe : `${safe}~${this._hash(raw).slice(0, 8)}`;
  }

  generateKey(dashboardKey, type, sql, params) {
    const canonical = [type, sql, params ? JSON.stringify(params) : ''].join('\u0000');
    const hash = this._hash(canonical);
    return `${this.prefix}:${this._namespace(dashboardKey)}:${hash}`;
  }

  async get(key) {
    const memHit = this.memGet(key);
    if (memHit !== undefined) {
      if (memHit === null) return null;
      return memHit;
    }

    if (!this.redisEnabled || !this.redis) return null;
    try {
      const data = await this.redis.get(key);
      if (!data) return null;
      const parsed = JSON.parse(data);
      this.memSet(key, parsed);
      return parsed;
    } catch (err) {
      console.log('[QueryCache] GET error:', err.message);
      return null;
    }
  }

  async set(key, data, ttl) {
    this.memSet(key, data, ttl);
    if (!this.redisEnabled || !this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', ttl || this.ttl);
    } catch (err) {
      console.log('[QueryCache] SET error:', err.message);
    }
  }

  memGet(key) {
    const entry = this.memStore.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.memStore.delete(key);
      return null;
    }
    return entry.data;
  }

  memSet(key, data, ttl) {
    this.memStore.set(key, {
      data,
      expires: Date.now() + ((ttl || this.ttl) * 1000),
    });
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.memStore) {
      if (entry.expires <= now) this.memStore.delete(key);
    }
  }

  async invalidate(pattern) {
    const memKeys = [...this.memStore.keys()].filter((k) => k.startsWith(pattern || this.prefix));
    for (const k of memKeys) this.memStore.delete(k);

    if (!this.redisEnabled || !this.redis) return;
    // SCAN rather than KEYS: KEYS is O(keyspace) and blocks the Redis server.
    const match = pattern ? `${pattern}*` : `${this.prefix}:*`;
    try {
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
        cursor = next;
        if (keys.length) {
          await this.redis.unlink(...keys).catch(() => this.redis.del(...keys));
          removed += keys.length;
        }
      } while (cursor !== '0');
      if (removed) console.log(`[QueryCache] Invalidated ${removed} keys`);
    } catch (err) {
      console.log('[QueryCache] INVALIDATE error:', err.message);
    }
  }

  async disconnect() {
    clearInterval(this.cleanupTimer);
    if (this.redis) {
      try { await this.redis.quit(); } catch (_) {}
    }
  }
}

module.exports = QueryCache;