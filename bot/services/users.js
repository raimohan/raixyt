'use strict';

const { config } = require('../config');
const { readJson, writeJsonAtomic } = require('../utils/fsx');
const log = require('../utils/logger').tag('users');

const DEFAULT_DB = { allowed: {}, pending: {}, blocked: {} };

let db = null;
let saveTimer = null;

function load() {
    if (db) return db;

    const raw = readJson(config.usersFile, null) || {};
    db = {
        allowed: raw.allowed && typeof raw.allowed === 'object' ? raw.allowed : {},
        pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : {},
        blocked: raw.blocked && typeof raw.blocked === 'object' ? raw.blocked : {}
    };

    // The owner and any ADMIN_IDS are always present, even on a fresh install.
    ensureRecord(config.ownerId, { role: 'owner', name: 'Owner' });
    for (const id of config.coAdmins) ensureRecord(id, { role: 'admin', name: `Admin ${id}` });

    return db;
}

function ensureRecord(id, patch) {
    if (!id) return null;
    const key = String(id);
    const current = db.allowed[key];

    db.allowed[key] = {
        id: Number(id),
        name: patch.name || current?.name || `User ${id}`,
        username: patch.username || current?.username || '',
        role: patch.role || current?.role || 'user',
        addedAt: current?.addedAt || new Date().toISOString(),
        addedBy: current?.addedBy || patch.addedBy || config.ownerId,
        lastSeen: current?.lastSeen || null,
        uses: current?.uses || 0
    };

    save();
    return db.allowed[key];
}

function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeJsonAtomic(config.usersFile, db || DEFAULT_DB);
    }, 400);
    if (saveTimer.unref) saveTimer.unref();
}

function saveNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    writeJsonAtomic(config.usersFile, db || DEFAULT_DB);
}

function isOwner(id) {
    return Number(id) === config.ownerId;
}

function isAdmin(id) {
    if (isOwner(id)) return true;
    load();
    const rec = db.allowed[String(id)];
    return !!rec && rec.role === 'admin';
}

function isBlocked(id) {
    load();
    return !!db.blocked[String(id)];
}

function isAllowed(id) {
    if (!id) return false;
    if (isOwner(id)) return true;
    if (isBlocked(id)) return false;
    load();
    if (config.openAccess) return true;
    return !!db.allowed[String(id)];
}

function touch(from) {
    if (!from) return;
    load();
    const rec = db.allowed[String(from.id)];
    if (!rec) return;

    rec.lastSeen = new Date().toISOString();
    rec.uses = (rec.uses || 0) + 1;
    if (from.first_name) rec.name = [from.first_name, from.last_name].filter(Boolean).join(' ');
    if (from.username) rec.username = from.username;
    save();
}

function add(id, meta = {}) {
    load();
    const key = String(id);
    delete db.blocked[key];
    delete db.pending[key];
    const rec = ensureRecord(id, { ...meta, role: meta.role || 'user' });
    log.ok(`Access granted to ${key}`);
    return rec;
}

function remove(id) {
    load();
    const key = String(id);
    if (isOwner(id)) return false;
    const existed = !!db.allowed[key];
    delete db.allowed[key];
    save();
    if (existed) log.info(`Access revoked for ${key}`);
    return existed;
}

function block(id) {
    load();
    if (isOwner(id)) return false;
    const key = String(id);
    db.blocked[key] = { id: Number(id), at: new Date().toISOString() };
    delete db.allowed[key];
    delete db.pending[key];
    save();
    return true;
}

function unblock(id) {
    load();
    const key = String(id);
    const existed = !!db.blocked[key];
    delete db.blocked[key];
    save();
    return existed;
}

function list() {
    load();
    return Object.values(db.allowed).sort((a, b) => {
        const rank = r => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
        return rank(a.role) - rank(b.role) || String(a.name).localeCompare(String(b.name));
    });
}

function listBlocked() {
    load();
    return Object.values(db.blocked);
}

function addPending(from) {
    load();
    const key = String(from.id);
    if (db.allowed[key] || db.blocked[key]) return null;

    db.pending[key] = {
        id: from.id,
        name: [from.first_name, from.last_name].filter(Boolean).join(' ') || `User ${from.id}`,
        username: from.username || '',
        at: new Date().toISOString()
    };
    save();
    return db.pending[key];
}

function getPending(id) {
    load();
    return db.pending[String(id)] || null;
}

function listPending() {
    load();
    return Object.values(db.pending).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function dropPending(id) {
    load();
    const key = String(id);
    const existed = !!db.pending[key];
    delete db.pending[key];
    save();
    return existed;
}

function counts() {
    load();
    const all = Object.values(db.allowed);
    return {
        total: all.length,
        admins: all.filter(u => u.role === 'admin' || u.role === 'owner').length,
        pending: Object.keys(db.pending).length,
        blocked: Object.keys(db.blocked).length
    };
}

module.exports = {
    load, saveNow,
    isOwner, isAdmin, isAllowed, isBlocked,
    touch, add, remove, block, unblock,
    list, listBlocked,
    addPending, getPending, listPending, dropPending,
    counts
};
