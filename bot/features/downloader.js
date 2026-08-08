'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const prefs = require('../services/prefs');
const { api } = require('../api/client');
const { deliver, directStreamLink } = require('../services/downloads');
const { kb, btn, grid, backRow } = require('../ui/keyboards');
const { esc, truncate, hidden } = require('../utils/format');

function menu() {
    return kb([
        [btn('🔗 Paste a link', 'd', 'ask')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '⬇️ <b>Downloader</b>',
        txt.RULE,
        '',
        'Send any link and I list every quality that fits, plus a clean MP3 option.',
        '',
        '<b>Works with</b>',
        'YouTube · Instagram · X/Twitter · TikTok',
        'Facebook · Vimeo · Pinterest · Snapchat',
        '',
        '<i>Cookie files on the Pi are used automatically for private or age-gated media.</i>'
    ].join('\n');
}

function analysisText(a) {
    const lines = [
        `${a.thumbnail ? hidden(a.thumbnail) : ''}⬇️ <b>${esc(truncate(a.title, 85))}</b>`,
        '',
        `🗂 ${esc(a.source || a.platform || 'unknown')}${a.duration && a.duration !== 'N/A' ? ` · ⏱ ${esc(a.duration)}` : ''}`,
        ''
    ];

    if (a.formats.length) {
        lines.push(`<b>${a.formats.length} quality option${a.formats.length === 1 ? '' : 's'}</b>`);
        lines.push(
            a.formats
                .slice(0, 12)
                .map(f => `  ${esc(f.resolution.padEnd(12, ' '))} ${esc(f.extension)}  ${esc(f.size)}`)
                .join('\n')
        );
        lines[lines.length - 1] = `<code>${lines[lines.length - 1]}</code>`;
    } else {
        lines.push('<i>No separate video qualities were reported — use Best available.</i>');
    }

    return lines.join('\n');
}

function analysisKeyboard(token, a) {
    const formatButtons = a.formats
        .slice(0, 12)
        .map((f, i) => btn(`${f.resolution} · ${f.size}`, 'd', 'go', token, i));

    return kb([
        ...grid(formatButtons, 2),
        [btn('⭐ Best available', 'd', 'best', token), btn('🎵 MP3 only', 'd', 'mp3', token)],
        [btn('✂️ Clip instead', 'c', 'load', token), btn('🧠 Summarize', 'a', 'sum2', token)],
        backRow('d', 'menu')
    ]);
}

async function analyze(ctx, url, progress) {
    const p = progress || await ui.Progress.open(ctx, 'Analyzing link');

    try {
        await p.stage('Analyzing link', '<i>Asking yt-dlp what is available…</i>');
        const data = await api.analyze(url);

        const analysis = {
            url,
            title: data.title || 'Untitled',
            thumbnail: data.thumbnail || '',
            duration: data.duration || '',
            source: data.source || '',
            platform: data.platform || '',
            formats: Array.isArray(data.formats) ? data.formats : []
        };

        const token = cache.put(analysis);
        return p.finish(analysisText(analysis), analysisKeyboard(token, analysis), { preview: !!analysis.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

function tokenUrl(token) {
    const entry = cache.get(token);
    return entry && entry.url ? entry : null;
}

async function pull(ctx, entry, { resolution, type, backToken }) {
    const label = type === 'audio' ? 'Extracting audio' : `Downloading ${resolution || 'best'}`;
    const ext = type === 'audio' ? 'mp3' : 'mp4';

    const caption = [
        `${entry.thumbnail ? hidden(entry.thumbnail) : ''}${type === 'audio' ? '🎵' : '🎬'} <b>${esc(truncate(entry.title || 'Download', 80))}</b>`,
        type === 'audio' ? '<i>MP3 · highest quality</i>' : `<i>${esc(resolution || 'best available')}</i>`
    ].join('\n');

    const backRows = backToken
        ? [[btn('◀️ Other qualities', 'd', 'back', backToken)], [btn('🏠 Home', 'h', 'menu')]]
        : [[btn('🏠 Home', 'h', 'menu')]];

    const videoId = /[?&]v=([A-Za-z0-9_-]{11})/.exec(entry.url)?.[1]
        || /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(entry.url)?.[1];

    // Only resolved if the file turns out to be too big for Telegram.
    const directLink = type === 'audio' || !videoId ? null : () => directStreamLink(videoId);

    const sendAs = prefs.get(ctx.from.id).sendAs;

    return deliver(ctx, {
        apiPath: '/api/download',
        params: { url: entry.url, resolution, type, title: entry.title },
        kind: type === 'audio' ? 'audio' : (sendAs === 'document' ? 'document' : 'video'),
        filenameHint: `${entry.title || 'download'}.${ext}`,
        caption,
        label,
        meta: type === 'audio' ? { title: entry.title } : {},
        markup: kb(backRows),
        directLink
    });
}

function register() {
    router.onMany({
        'd:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'd:ask': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video or post', next: 'analyze', back: ['d', 'menu'] });
        },

        'd:an': async (ctx, [token]) => {
            await ui.ack(ctx, '🔍 Analyzing…');
            const entry = tokenUrl(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());
            return analyze(ctx, entry.url);
        },

        'd:back': async (ctx, [token]) => {
            await ui.ack(ctx);
            const entry = cache.get(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());
            return ui.show(ctx, analysisText(entry), analysisKeyboard(token, entry), { preview: !!entry.thumbnail });
        },

        'd:go': async (ctx, [token, index]) => {
            await ui.ack(ctx, '⬇️ Starting…');

            const entry = cache.get(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());

            const format = entry.formats[parseInt(index, 10)];
            if (!format) return ui.send(ctx, '⌛ That quality is gone — analyze again.', menu());

            return pull(ctx, entry, { resolution: format.resolution, type: 'video', backToken: token });
        },

        'd:best': async (ctx, [token]) => {
            await ui.ack(ctx, '⬇️ Starting…');
            const entry = cache.get(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());
            return pull(ctx, entry, { resolution: 'best', type: 'video', backToken: entry.formats ? token : null });
        },

        'd:mp3': async (ctx, [token]) => {
            await ui.ack(ctx, '🎵 Starting…');
            const entry = tokenUrl(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());
            return pull(ctx, entry, { type: 'audio', backToken: entry.formats ? token : null });
        },

        'd:quick': async (ctx, [token]) => {
            await ui.ack(ctx, '⬇️ Starting…');
            const entry = tokenUrl(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired. Send it again.', menu());

            const quality = prefs.get(ctx.from.id).quality;
            return pull(ctx, entry, { resolution: quality, type: 'video', backToken: null });
        }
    });

    flow.onUrl('analyze', async (ctx, url) => analyze(ctx, url));
}

module.exports = { register, menu, analyze };
