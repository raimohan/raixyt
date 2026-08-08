'use strict';

const { config } = require('../config');
const { esc, truncate, hidden, num, hhmmss, ytDate, bytes } = require('../utils/format');

const RULE = '─────────────────────';

function title(icon, text) {
    return `${icon} <b>${esc(text)}</b>`;
}

function home(user) {
    const name = esc(user.first_name || 'there');
    return [
        `✨ <b>${esc(config.brandName)}</b>`,
        '',
        `Hey ${name} — everything below runs on your Pi.`,
        'Pick a module; no commands to memorise.',
        '',
        '<i>Tip: paste any video link at any time and I will offer what I can do with it.</i>'
    ].join('\n');
}

function help() {
    return [
        title('❓', 'How this bot works'),
        RULE,
        '',
        '<b>Buttons, not commands.</b> Every screen is reachable by tapping.',
        'Only three commands exist:',
        '• /start — open the main menu',
        '• /menu — same thing, from anywhere',
        '• /id — show your Telegram id',
        '',
        '<b>Paste a link</b> — YouTube, Instagram, X, TikTok, Facebook, Vimeo, Pinterest, Snapchat — and a quick-action card appears.',
        '',
        '<b>Modules</b>',
        '🎬 Video — search, inspect, download any quality',
        '🎵 Music — search and pull clean MP3s with cover art',
        '⬇️ Downloader — one link, every available format',
        '✂️ Clip Studio — cut up to 60s, reframe to 9:16 or 1:1',
        '📝 Subtitles — list tracks, preview, export SRT/VTT/TXT',
        '🧠 AI Studio — summaries, viral moments, tags, titles, descriptions',
        '📚 Study — transcript, quiz, flashcards, class notes, plans',
        '💬 Video Chat — ask questions about a video',
        '📊 Insights — metadata, thumbnails, channel analysis',
        '🎓 Courses — turn a playlist or channel into a course',
        '',
        `<i>Uploads are capped at ${config.maxUploadMb} MB by Telegram. Bigger files come back as a direct link.</i>`
    ].join('\n');
}

function denied() {
    return [
        '🔒 <b>Private bot</b>',
        '',
        'This bot is restricted to approved users.',
        'Tap below and the owner will get your request.'
    ].join('\n');
}

function videoCard(v, extra = {}) {
    const lines = [
        `${extra.thumb !== false && v.thumbnail ? hidden(v.thumbnail) : ''}🎬 <b>${esc(truncate(v.title, 90))}</b>`,
        '',
        `👤 ${esc(v.channel || v.uploader || v.artist || 'Unknown')}`
    ];

    if (v.duration) lines.push(`⏱ ${esc(v.duration)}`);
    if (v.views && v.views !== 'N/A') lines.push(`👁 ${esc(v.views)}`);
    if (v.uploadDate && v.uploadDate !== 'Unknown') lines.push(`📅 ${esc(v.uploadDate)}`);
    if (Array.isArray(v.qualities) && v.qualities.length) {
        lines.push(`🎚 ${esc(v.qualities.join(' · '))}`);
    }

    if (v.description) {
        const d = truncate(String(v.description).replace(/\s+/g, ' '), 220);
        if (d) lines.push('', `<i>${esc(d)}</i>`);
    }

    return lines.join('\n');
}

function metadataCard(m) {
    return [
        `${m.thumbnail ? hidden(m.thumbnail) : ''}📊 <b>${esc(truncate(m.title, 90))}</b>`,
        '',
        `👤 <b>Channel</b>  ${esc(m.uploader || '—')}`,
        `⏱ <b>Length</b>   ${esc(m.duration_string || hhmmss(m.duration))}`,
        `👁 <b>Views</b>    ${esc(num(m.view_count))}`,
        `👍 <b>Likes</b>    ${esc(num(m.like_count))}`,
        `💬 <b>Comments</b> ${esc(num(m.comment_count))}`,
        `📅 <b>Published</b> ${esc(ytDate(m.upload_date))}`,
        m.categories?.length ? `🗂 <b>Category</b> ${esc(m.categories.join(', '))}` : null,
        m.tags?.length ? `\n🏷 <b>Tags (${m.tags.length})</b>\n<code>${esc(m.tags.slice(0, 25).join(', '))}</code>` : null
    ].filter(Boolean).join('\n');
}

function channelCard(c) {
    return [
        `${c.avatar ? hidden(c.avatar) : ''}📺 <b>${esc(c.name)}</b>${c.handle ? `  <code>${esc(c.handle)}</code>` : ''}`,
        '',
        `👥 <b>Subscribers</b>  ${esc(num(c.subscribers))}`,
        `🎞 <b>Videos</b>       ${esc(num(c.videoCount))}`,
        `👁 <b>Total views</b>  ${esc(num(c.totalViews))}`,
        c.channelAge ? `🎂 <b>Age</b>          ${esc(c.channelAge)}` : null,
        c.country ? `🌍 <b>Country</b>      ${esc(c.country)}` : null,
        c.description ? `\n<i>${esc(truncate(c.description, 300))}</i>` : null
    ].filter(Boolean).join('\n');
}

function courseCard(c) {
    const hours = (c.totalDurationSec / 3600).toFixed(1);
    return [
        `${c.thumbUrl ? hidden(c.thumbUrl) : ''}🎓 <b>${esc(truncate(c.title, 90))}</b>`,
        '',
        `👤 ${esc(c.author || '—')}`,
        `📚 ${c.videoCount} lessons · ${hours} h total`,
        `🔗 ${esc(c.sourceType)}`
    ].join('\n');
}

function tooBig(sizeLabel, link) {
    return [
        '📦 <b>Too large for Telegram</b>',
        '',
        `Telegram caps bot uploads at <b>${config.maxUploadMb} MB</b>${sizeLabel ? ` and this file is ${esc(sizeLabel)}` : ''}.`,
        link ? `\n<a href="${esc(link)}">⬇️ Direct download link</a>\n\n<i>The link is signed and expires in a few hours.</i>` : '\nTry a lower quality.'
    ].join('\n');
}

function askUrl(what) {
    return [
        `🔗 <b>Send a link</b>`,
        '',
        `Paste the URL of the ${esc(what)} you want to work with.`,
        '',
        '<i>YouTube, Instagram, X/Twitter, TikTok, Facebook, Vimeo, Pinterest and Snapchat are supported.</i>'
    ].join('\n');
}

function ask(prompt, hint) {
    return [`⌨️ <b>${esc(prompt)}</b>`, hint ? `\n<i>${esc(hint)}</i>` : null].filter(Boolean).join('\n');
}

function healthCard(h) {
    const cookies = (h.cookies || []).length
        ? h.cookies.map(c => `✅ ${esc(c)}`).join('  ')
        : '⚠️ none loaded';

    return [
        '❤️ <b>Backend health</b>',
        RULE,
        `<b>Status</b>     ${esc(h.status || 'unknown')}`,
        `<b>Uptime</b>     ${esc(hhmmss(h.uptime))}`,
        `<b>AI</b>         ${esc(h.aiProvider)} · ${esc(h.aiModel)}`,
        `<b>AI keys</b>    ${h.aiKeys} ${h.aiReady ? '✅' : '❌'}`,
        `<b>yt-dlp</b>     <code>${esc(h.ytdlp)}</code>`,
        `<b>ffmpeg</b>     <code>${esc(h.ffmpeg)}</code>`,
        `<b>Cookies</b>    ${cookies}`
    ].join('\n');
}

function statsCard(s, sys) {
    const top = s.top.length
        ? s.top.map(([k, v]) => `  ${esc(k.padEnd(18, ' '))} ${v}`).join('\n')
        : '  (nothing yet)';

    return [
        '📈 <b>Bot statistics</b>',
        RULE,
        `<b>Actions</b>   ${s.total}`,
        `<b>Errors</b>    ${s.errors}`,
        `<b>Sent</b>      ${esc(bytes(s.bytesSent))}`,
        `<b>Since</b>     ${esc(String(s.startedAt).slice(0, 16).replace('T', ' '))}`,
        '',
        `<b>Process</b>`,
        `  uptime   ${esc(hhmmss(sys.uptime))}`,
        `  memory   ${esc(bytes(sys.rss))}`,
        `  sessions ${sys.sessions}`,
        `  queue    ${sys.queueActive} running · ${sys.queueWaiting} waiting`,
        '',
        `<b>Top actions</b>`,
        `<code>${top}</code>`
    ].join('\n');
}

module.exports = {
    RULE, title, home, help, denied,
    videoCard, metadataCard, channelCard, courseCard,
    tooBig, askUrl, ask, healthCard, statsCard
};
