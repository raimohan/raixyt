'use strict';

const { config } = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] !== undefined ? LEVELS[config.logLevel] : LEVELS.info;

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level, icon, tag, args) {
    if (LEVELS[level] > threshold) return;
    const prefix = `${icon} ${stamp()}${tag ? ` [${tag}]` : ''}`;
    const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    stream(prefix, ...args);
}

function build(tag) {
    return {
        error: (...a) => emit('error', '❌', tag, a),
        warn: (...a) => emit('warn', '⚠️ ', tag, a),
        info: (...a) => emit('info', 'ℹ️ ', tag, a),
        debug: (...a) => emit('debug', '🔎', tag, a),
        ok: (...a) => emit('info', '✅', tag, a),
        tag: name => build(name)
    };
}

module.exports = build(null);
