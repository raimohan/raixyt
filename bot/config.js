'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function toIdList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0);
}

const PORT = toInt(process.env.PORT, 3000);

const config = {
    root: ROOT,

    botToken: (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    ownerId: toInt(process.env.OWNER_ID, 0),
    coAdmins: toIdList(process.env.ADMIN_IDS),

    apiBase: (process.env.API_BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, ''),
    adminToken: (process.env.ADMIN_TOKEN || '').trim(),

    dataDir: process.env.BOT_DATA_DIR || path.join(ROOT, 'data'),
    tmpDir: process.env.BOT_TMP_DIR || path.join(ROOT, 'bot_tmp'),
    cookiesDir: process.env.COOKIES_DIR || ROOT,

    maxUploadMb: toInt(process.env.MAX_UPLOAD_MB, 49),
    maxConcurrentJobs: toInt(process.env.MAX_CONCURRENT_JOBS, 2),

    apiTimeoutMs: toInt(process.env.API_TIMEOUT_MS, 180000),
    idleTimeoutMs: toInt(process.env.DOWNLOAD_IDLE_TIMEOUT_MS, 240000),
    handlerTimeoutMs: toInt(process.env.HANDLER_TIMEOUT_MS, 900000),

    sessionTtlMs: toInt(process.env.SESSION_TTL_MS, 45 * 60 * 1000),
    cacheTtlMs: toInt(process.env.CACHE_TTL_MS, 60 * 60 * 1000),
    cacheMaxEntries: toInt(process.env.CACHE_MAX_ENTRIES, 800),

    throttleWindowMs: toInt(process.env.THROTTLE_WINDOW_MS, 1000),
    throttleMax: toInt(process.env.THROTTLE_MAX, 4),

    logLevel: (process.env.BOT_LOG_LEVEL || 'info').toLowerCase(),
    brandName: (process.env.BOT_NAME || 'RaiX Studio').trim(),
    openAccess: toBool(process.env.OPEN_ACCESS, false),
    dropPendingUpdates: toBool(process.env.DROP_PENDING_UPDATES, true),

    pm2ApiName: (process.env.PM2_API_NAME || 'raix-api').trim(),
    pm2BotName: (process.env.PM2_BOT_NAME || 'raix-bot').trim(),

    get usersFile() { return path.join(config.dataDir, 'users.json'); },
    get prefsFile() { return path.join(config.dataDir, 'prefs.json'); },
    get statsFile() { return path.join(config.dataDir, 'stats.json'); },
    get maxUploadBytes() { return config.maxUploadMb * 1024 * 1024; }
};

const PLATFORM_COOKIE_FILES = {
    youtube: 'youtube.txt',
    instagram: 'instagram.txt'
};

config.cookieFiles = PLATFORM_COOKIE_FILES;

function validate() {
    const problems = [];

    if (!config.botToken) {
        problems.push('BOT_TOKEN is missing. Create a bot with @BotFather and put the token in .env');
    } else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(config.botToken)) {
        problems.push('BOT_TOKEN does not look like a Telegram token (expected "123456:ABC-DEF...").');
    }

    if (!config.ownerId) {
        problems.push('OWNER_ID is missing. Send /id to @userinfobot and put your numeric id in .env');
    }

    return problems;
}

function ensureDirs() {
    for (const dir of [config.dataDir, config.tmpDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

module.exports = { config, validate, ensureDirs };
