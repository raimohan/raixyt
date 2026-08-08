'use strict';

const { config } = require('../config');

const sessions = new Map();

function blank() {
    return {
        awaiting: null,   // { type, data, keep }
        chat: null,       // active "chat with video" conversation
        lastMenu: null,
        scratch: {},
        touchedAt: Date.now()
    };
}

function get(userId) {
    let s = sessions.get(userId);
    if (!s) {
        s = blank();
        sessions.set(userId, s);
    }
    s.touchedAt = Date.now();
    return s;
}

function reset(userId) {
    sessions.set(userId, blank());
    return sessions.get(userId);
}

/**
 * Park the user in "waiting for typed input" mode. `keep: true` survives one
 * message (used by the chat loop, which stays open until the user leaves).
 */
function await_(userId, type, data = {}, opts = {}) {
    const s = get(userId);
    s.awaiting = { type, data, keep: !!opts.keep };
    return s;
}

function clearAwait(userId) {
    const s = get(userId);
    s.awaiting = null;
    return s;
}

function peekAwait(userId) {
    return get(userId).awaiting;
}

function sweep() {
    const cutoff = Date.now() - config.sessionTtlMs;
    let removed = 0;
    for (const [id, s] of sessions) {
        if (s.touchedAt < cutoff) {
            sessions.delete(id);
            removed++;
        }
    }
    return removed;
}

setInterval(sweep, 10 * 60 * 1000).unref();

module.exports = {
    get,
    reset,
    setAwait: await_,
    clearAwait,
    peekAwait,
    sweep,
    get size() { return sessions.size; }
};
