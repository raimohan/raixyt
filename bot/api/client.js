'use strict';

const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { config } = require('../config');
const log = require('../utils/logger').tag('api');
const { ensureDir, safeFilename, safeUnlink } = require('../utils/fsx');

class ApiError extends Error {
    constructor(message, status, detail) {
        super(message);
        this.name = 'ApiError';
        this.status = status || 0;
        this.detail = detail || null;
    }
}

function buildUrl(pathname, params) {
    const url = new URL(pathname.startsWith('http') ? pathname : config.apiBase + pathname);
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
    }
    return url.toString();
}

function friendlyNetworkError(err) {
    const code = err && (err.cause?.code || err.code);

    if (err && err.name === 'AbortError') {
        return new ApiError('The backend took too long to answer. It may still be working — try again in a moment.', 408);
    }
    if (code === 'ECONNREFUSED') {
        return new ApiError(`The backend is not reachable at ${config.apiBase}. Start it with "pm2 start ${config.pm2ApiName}".`, 503);
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new ApiError(`Cannot resolve the backend host (${config.apiBase}).`, 503);
    }

    return new ApiError(err && err.message ? err.message : 'Network error talking to the backend.', 0);
}

async function readError(res) {
    let detail = null;
    let message = `Backend returned ${res.status}`;

    try {
        const text = await res.text();
        if (text) {
            try {
                const json = JSON.parse(text);
                detail = json;
                if (json.error) message = json.error;
                if (json.reason) message += ` (${json.reason})`;
            } catch (parseErr) {
                message = text.slice(0, 300).trim() || message;
            }
        }
    } catch (err) { /* body already consumed or empty */ }

    return new ApiError(message, res.status, detail);
}

async function request(method, pathname, { params, body, timeoutMs, headers } = {}) {
    const url = buildUrl(pathname, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || config.apiTimeoutMs);

    const started = Date.now();

    try {
        const res = await fetch(url, {
            method,
            signal: controller.signal,
            headers: {
                accept: 'application/json',
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...(headers || {})
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (!res.ok) throw await readError(res);

        const text = await res.text();
        log.debug(`${method} ${pathname} -> ${res.status} in ${Date.now() - started}ms`);

        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch (err) {
            throw new ApiError('Backend sent a response that is not JSON.', res.status);
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw friendlyNetworkError(err);
    } finally {
        clearTimeout(timer);
    }
}

const apiGet = (pathname, params, opts) => request('GET', pathname, { params, ...opts });
const apiPost = (pathname, body, opts) => request('POST', pathname, { body, ...opts });

function parseFilename(disposition) {
    if (!disposition) return null;

    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (encoded) {
        try { return decodeURIComponent(encoded[1]); } catch (err) { /* fall through */ }
    }

    const quoted = /filename\s*=\s*"([^"]*)"/i.exec(disposition);
    if (quoted) return quoted[1];

    const bare = /filename\s*=\s*([^;]+)/i.exec(disposition);
    return bare ? bare[1].trim() : null;
}

/**
 * Stream a backend response to disk.
 *
 * The Telegram Bot API refuses uploads over 50 MB, so oversize bodies are
 * abandoned mid-flight instead of filling the SD card for nothing.
 */
async function downloadTo(pathname, params, opts = {}) {
    const url = buildUrl(pathname, params);
    const destDir = ensureDir(opts.destDir || config.tmpDir);
    const maxBytes = opts.maxBytes || config.maxUploadBytes;
    const idleMs = opts.idleTimeoutMs || config.idleTimeoutMs;

    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), idleMs);
    const bump = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), idleMs);
    };

    let tooBig = false;
    let destPath = null;

    try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) throw await readError(res);

        const total = Number(res.headers.get('content-length') || 0);
        const filename = safeFilename(
            parseFilename(res.headers.get('content-disposition')) || opts.filenameHint || `file_${Date.now()}`
        );

        if (total && total > maxBytes) {
            controller.abort();
            return { tooBig: true, size: total, filename, path: null };
        }

        destPath = path.join(destDir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(filename) || ''}`);

        let received = 0;
        let lastNotify = 0;

        const counter = new Transform({
            transform(chunkBuf, _enc, cb) {
                received += chunkBuf.length;
                bump();

                if (received > maxBytes) {
                    tooBig = true;
                    cb(new Error('__TOO_BIG__'));
                    return;
                }

                if (opts.onProgress && Date.now() - lastNotify > 800) {
                    lastNotify = Date.now();
                    try { opts.onProgress(received, total); } catch (err) { /* UI only */ }
                }

                cb(null, chunkBuf);
            }
        });

        await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));

        if (opts.onProgress) {
            try { opts.onProgress(received, total || received); } catch (err) { /* UI only */ }
        }

        return { tooBig: false, path: destPath, filename, size: received, total: total || received };
    } catch (err) {
        safeUnlink(destPath);

        if (tooBig || (err && err.message === '__TOO_BIG__')) {
            return { tooBig: true, size: maxBytes, filename: opts.filenameHint || 'file', path: null };
        }
        if (err instanceof ApiError) throw err;
        throw friendlyNetworkError(err);
    } finally {
        clearTimeout(idleTimer);
    }
}

// ---- Typed wrappers for every backend route the bot touches ----------------

const api = {
    health: () => apiGet('/health', null, { timeoutMs: 15000 }),

    musicSearch: query => apiPost('/api/music/search', { query }),
    musicPlaylist: url => apiPost('/api/music/playlist', { url }),
    musicDownloadUrl: (id, title, artist) => buildUrl('/api/music/download', { id, title, artist }),

    videoSearch: query => apiPost('/api/video/search', { query }),
    videoInfo: url => apiPost('/api/video/info', { url }),
    videoPlaylist: url => apiPost('/api/video/playlist', { url }),
    videoStream: (id, extra) => apiGet('/api/video/stream', { id, json: 1, hls: 1, ...extra }),

    analyze: url => apiPost('/api/analyze', { url }),
    downloadParams: (url, resolution, type, title) => ({ url, resolution, type, title }),

    clipStatus: jobId => apiGet(`/api/clip/status/${encodeURIComponent(jobId)}`, null, { timeoutMs: 20000 }),

    subtitles: url => apiPost('/api/subtitles', { url }),
    subtitlePreview: (url, lang) => apiPost('/api/subtitles/preview', { url, lang }),

    summarize: (url, type, refresh) => apiPost('/api/summarize', { url, type, refresh: !!refresh }, { timeoutMs: 300000 }),
    viral: (url, excludedRanges) => apiPost('/api/viral', { url, excludedRanges: excludedRanges || [] }, { timeoutMs: 300000 }),
    tags: (title, existingTags) => apiPost('/api/tags/generate', { title, existingTags: existingTags || [] }),
    titles: (topic, style) => apiPost('/api/titles/generate', { topic, style }),
    description: payload => apiPost('/api/description/generate', payload),

    chatInfo: url => apiGet('/api/chat/info', { url }),
    chat: (videoId, videoData, messages) => apiPost('/api/chat', { videoId, videoData, messages }, { timeoutMs: 240000 }),

    transcript: url => apiPost('/api/transcript', { url }, { timeoutMs: 240000 }),
    quiz: (url, refresh) => apiPost('/api/quiz', { url, refresh: !!refresh }, { timeoutMs: 300000 }),
    flashcards: (url, refresh) => apiPost('/api/flashcards', { url, refresh: !!refresh }, { timeoutMs: 300000 }),
    aiNotes: (url, refresh) => apiPost('/api/ai-notes', { url, refresh: !!refresh }, { timeoutMs: 300000 }),
    plan: (goal, videoCount, totalDurationSec) => apiPost('/api/plan', { goal, videoCount, totalDurationSec }),

    courseResolve: input => apiPost('/api/course/resolve', { input }, { timeoutMs: 300000 }),
    courseSearch: query => apiPost('/api/course/search', { query }),

    thumbnail: url => apiPost('/api/thumbnail', { url }),
    metadata: url => apiPost('/api/metadata', { url }),
    channelAnalyze: input => apiPost('/api/channel/analyze', { input }, { timeoutMs: 300000 })
};

module.exports = { api, apiGet, apiPost, downloadTo, buildUrl, ApiError };
