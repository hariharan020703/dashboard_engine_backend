class SchemaCache {
  constructor(ttlMs) {
    this.ttl = ttlMs || 5 * 60 * 1000;
    this.store = new Map();
    this.timer = setInterval(() => this.cleanup(), Math.min(60000, this.ttl));
    if (this.timer.unref) this.timer.unref();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttl) {
    this.store.set(key, {
      value,
      expires: Date.now() + (ttl || this.ttl),
    });
  }

  invalidate(key) {
    this.store.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expires <= now) this.store.delete(key);
    }
  }
}

module.exports = SchemaCache;