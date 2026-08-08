'use strict';

const { config } = require('../config');
const { readJson, writeJsonAtomic } = require('../utils/fsx');

let store = null;
let timer = null;

function load() {
    if (!store) {
        store = readJson(config.statsFile, null) || {};
        if (!store.actions) store.actions = {};
        if (!store.errors) store.errors = 0;
        if (!store.startedAt) store.startedAt = new Date().toISOString();
        if (!store.bytesSent) store.bytesSent = 0;
    }
    return store;
}

function save() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        writeJsonAtomic(config.statsFile, store);
    }, 2000);
    if (timer.unref) timer.unref();
}

function bump(action, by = 1) {
    load();
    store.actions[action] = (store.actions[action] || 0) + by;
    save();
}

function bumpError() {
    load();
    store.errors += 1;
    save();
}

function addBytes(n) {
    load();
    store.bytesSent += Number(n) || 0;
    save();
}

function snapshot() {
    load();
    const actions = Object.entries(store.actions).sort((a, b) => b[1] - a[1]);
    const total = actions.reduce((sum, [, v]) => sum + v, 0);
    return {
        startedAt: store.startedAt,
        errors: store.errors,
        bytesSent: store.bytesSent,
        total,
        top: actions.slice(0, 12)
    };
}

module.exports = { bump, bumpError, addBytes, snapshot };
