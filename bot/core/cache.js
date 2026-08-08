'use strict';

const crypto = require('crypto');
const { config } = require('../config');

/**
 * Telegram caps callback_data at 64 bytes, which is nowhere near enough for a
 * search-result list or a quiz. Payloads live here instead and the button only
 * carries a short token.
 */
class TokenStore {
    constructor({ max = 800, ttl = 3600000 } = {}) {
        this.max = max;
        this.ttl = ttl;
        this.map = new Map();
    }

    _token() {
        return crypto.randomBytes(5).toString('base64url');
    }

    put(value, ttlMs) {
        let token = this._token();
        while (this.map.has(token)) token = this._token();

        this.set(token, value, ttlMs);
        return token;
    }

    set(token, value, ttlMs) {
        if (this.map.size >= this.max) this._evict();
        this.map.set(token, { value, expiresAt: Date.now() + (ttlMs || this.ttl) });
        return token;
    }

    get(token) {
        const hit = this.map.get(token);
        if (!hit) return null;

        if (Date.now() >= hit.expiresAt) {
            this.map.delete(token);
            return null;
        }

        // Touch: keeps active flows (a long quiz, a paginated list) alive.
        this.map.delete(token);
        this.map.set(token, hit);
        return hit.value;
    }

    has(token) {
        return this.get(token) !== null;
    }

    del(token) {
        this.map.delete(token);
    }

    _evict() {
        const now = Date.now();
        for (const [key, entry] of this.map) {
            if (now >= entry.expiresAt) this.map.delete(key);
        }

        // Still full? Drop the least recently touched quarter.
        if (this.map.size >= this.max) {
            const drop = Math.max(1, Math.floor(this.max / 4));
            let i = 0;
            for (const key of this.map.keys()) {
                this.map.delete(key);
                if (++i >= drop) break;
            }
        }
    }

    sweep() {
        const now = Date.now();
        let removed = 0;
        for (const [key, entry] of this.map) {
            if (now >= entry.expiresAt) {
                this.map.delete(key);
                removed++;
            }
        }
        return removed;
    }

    get size() {
        return this.map.size;
    }
}

const store = new TokenStore({ max: config.cacheMaxEntries, ttl: config.cacheTtlMs });

setInterval(() => store.sweep(), 5 * 60 * 1000).unref();

module.exports = store;
module.exports.TokenStore = TokenStore;
