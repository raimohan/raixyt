'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger').tag('fs');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        log.warn(`Unreadable JSON at ${file}: ${err.message}`);
        return fallback;
    }
}

function writeJsonAtomic(file, value) {
    try {
        ensureDir(path.dirname(file));
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (err) {
        log.error(`Failed to write ${file}: ${err.message}`);
        return false;
    }
}

function safeUnlink(file) {
    try {
        if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
        log.debug(`unlink ${file}: ${err.message}`);
    }
}

function safeFilename(name, fallback = 'file') {
    const cleaned = String(name || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || fallback).slice(0, 120);
}

function statSize(file) {
    try {
        return fs.statSync(file).size;
    } catch (err) {
        return 0;
    }
}

function sweep(dir, maxAgeMs) {
    let removed = 0;
    try {
        if (!fs.existsSync(dir)) return 0;
        const now = Date.now();
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            try {
                const st = fs.statSync(full);
                if (st.isDirectory()) continue;
                if (now - st.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(full);
                    removed++;
                }
            } catch (err) { /* file vanished mid-sweep */ }
        }
    } catch (err) {
        log.warn(`sweep ${dir}: ${err.message}`);
    }
    return removed;
}

module.exports = { ensureDir, readJson, writeJsonAtomic, safeUnlink, safeFilename, statSize, sweep };
