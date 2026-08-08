'use strict';

const { config } = require('../config');
const { readJson, writeJsonAtomic } = require('../utils/fsx');

const DEFAULTS = {
    quality: 'best',        // default video resolution for one-tap downloads
    sendAs: 'video',        // video | document
    summaryType: 'brief',   // brief | detailed | keypoints | chapters
    subFormat: 'srt',       // srt | vtt | txt
    titleStyle: 'viral',    // viral | curiosity | howto | listicle
    clipQuality: '720',     // 360 | 480 | 720 | 1080
    clipRatio: 'original',  // original | 9:16 | 1:1
    descType: 'standard',   // standard | detailed | minimal
    autoThumb: true         // attach the video thumbnail preview to cards
};

let store = null;
let timer = null;

function load() {
    if (!store) store = readJson(config.prefsFile, {}) || {};
    return store;
}

function save() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        writeJsonAtomic(config.prefsFile, store || {});
    }, 500);
    if (timer.unref) timer.unref();
}

function get(userId) {
    load();
    return { ...DEFAULTS, ...(store[String(userId)] || {}) };
}

function set(userId, key, value) {
    load();
    const key_ = String(userId);
    store[key_] = { ...(store[key_] || {}), [key]: value };
    save();
    return get(userId);
}

function patch(userId, values) {
    load();
    const key = String(userId);
    store[key] = { ...(store[key] || {}), ...values };
    save();
    return get(userId);
}

function reset(userId) {
    load();
    delete store[String(userId)];
    save();
    return { ...DEFAULTS };
}

module.exports = { DEFAULTS, get, set, patch, reset };
