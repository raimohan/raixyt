'use strict';

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function esc(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[&<>"]/g, ch => HTML_ENTITIES[ch]);
}

function truncate(value, max = 60) {
    const s = String(value === undefined || value === null ? '' : value);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function chunk(text, size = 3600) {
    const out = [];
    let rest = String(text || '');

    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
        if (cut < size * 0.5) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, '');
    }

    if (rest.length) out.push(rest);
    return out.length ? out : [''];
}

function bytes(n) {
    const value = Number(n) || 0;
    if (value <= 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1048576).toFixed(1)} MB`;
    return `${(value / 1073741824).toFixed(2)} GB`;
}

function num(n) {
    const value = Number(n) || 0;
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return String(value);
}

function hhmmss(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p = v => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

// Accepts "90", "1:30", "01:02:03" -> seconds. Returns null when unparseable.
function parseTime(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) return parseInt(raw, 10);

    const parts = raw.split(':').map(p => p.trim());
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every(p => /^\d+$/.test(p))) return null;

    return parts.reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
}

function bar(ratio, width = 12) {
    const pct = Math.min(1, Math.max(0, Number(ratio) || 0));
    const filled = Math.round(pct * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function elapsed(sinceMs) {
    return hhmmss((Date.now() - sinceMs) / 1000);
}

// Zero-width anchor: gives the message a link preview (thumbnail) without
// showing a visible link.
function hidden(url) {
    if (!url || !/^https?:\/\//i.test(url)) return '';
    return `<a href="${esc(url)}">&#8288;</a>`;
}

function isUrl(text) {
    return /^https?:\/\/\S+$/i.test(String(text || '').trim());
}

function looksLikeUrl(text) {
    return /https?:\/\/\S+/i.test(String(text || ''));
}

function firstUrl(text) {
    const m = /https?:\/\/\S+/i.exec(String(text || ''));
    return m ? m[0] : null;
}

function ytDate(compact) {
    const s = String(compact || '');
    if (!/^\d{8}$/.test(s)) return s || 'Unknown';
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}

function pad(text, width) {
    const s = String(text);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function pct(ratio) {
    return `${Math.round(Math.min(1, Math.max(0, Number(ratio) || 0)) * 100)}%`;
}

module.exports = {
    esc, truncate, chunk, bytes, num, hhmmss, parseTime,
    bar, elapsed, hidden, isUrl, looksLikeUrl, firstUrl, ytDate, pad, pct
};
