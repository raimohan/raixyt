'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { api } = require('../api/client');
const { kb, btn, grid, paginated, backRow } = require('../ui/keyboards');
const { esc, truncate, num, hidden } = require('../utils/format');

const PER_PAGE = 5;

function menu() {
    return kb([
        [btn('📊 Video metadata', 'an', 'meta')],
        [btn('🖼 Thumbnails', 'an', 'thumb')],
        [btn('📺 Analyze a channel', 'an', 'ch')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '📊 <b>Insights</b>',
        txt.RULE,
        '',
        '<b>Metadata</b> — views, likes, comments, tags, category',
        '<b>Thumbnails</b> — every resolution the platform stores, downloadable',
        '<b>Channel</b> — subscribers, total views, age and recent uploads'
    ].join('\n');
}

// --- Metadata --------------------------------------------------------------

async function runMetadata(ctx, url) {
    const p = await ui.Progress.open(ctx, 'Reading metadata');

    try {
        const data = await api.metadata(url);
        const token = cache.put({ url, title: data.title, thumbnail: data.thumbnail });

        const markup = kb([
            [btn('🖼 Thumbnails', 'an', 'thumb2', token), btn('🏷 Tag ideas', 'an', 'tagsfrom', token)],
            [btn('⬇️ Download', 'd', 'an', token), btn('🧠 Summarize', 'a', 'sum2', token)],
            backRow('an', 'menu')
        ]);

        const body = txt.metadataCard(data);

        if (body.length <= 3800) return p.finish(body, markup, { preview: !!data.thumbnail });

        await p.remove();
        return ui.sendLong(ctx, body, markup, { preview: !!data.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Thumbnails ------------------------------------------------------------

function pickThumbs(list) {
    const seen = new Set();
    const out = [];

    for (const t of [...(list || [])].reverse()) {
        if (!t || !t.url) continue;
        const key = `${t.width || 0}x${t.height || 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= 8) break;
    }

    return out;
}

async function runThumbnails(ctx, url) {
    const p = await ui.Progress.open(ctx, 'Fetching thumbnails');

    try {
        const data = await api.thumbnail(url);
        const thumbs = pickThumbs(data.thumbnails);

        if (!thumbs.length && !data.thumbnail) {
            return p.finish('🖼 <b>No thumbnails</b>\n\nNothing was published for this video.', menu());
        }

        const token = cache.put({ url, title: data.title, thumbnail: data.thumbnail, thumbs });

        const text = [
            `${data.thumbnail ? hidden(data.thumbnail) : ''}🖼 <b>${esc(truncate(data.title, 80))}</b>`,
            '',
            `👤 ${esc(data.uploader || '—')}`,
            `📐 ${thumbs.length} size${thumbs.length === 1 ? '' : 's'} available`,
            '',
            '<i>Pick a size — it arrives as an uncompressed file.</i>'
        ].join('\n');

        const buttons = thumbs.map((t, i) =>
            btn(t.width ? `${t.width}×${t.height}` : `Size ${i + 1}`, 'an', 'tget', token, i)
        );

        return p.finish(text, kb([
            ...grid(buttons, 2),
            [btn('🖼 Send the default', 'an', 'tget', token, 'd')],
            backRow('an', 'menu')
        ]), { preview: true });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Channel ---------------------------------------------------------------

function channelListText(ch, page, pages) {
    const slice = ch.videos.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

    return [
        txt.channelCard(ch),
        '',
        txt.RULE,
        `<b>Recent uploads</b> · page ${page + 1} of ${pages}`,
        '',
        slice.map((v, i) => [
            `<b>${page * PER_PAGE + i + 1}.</b> ${esc(truncate(v.title, 58))}`,
            `     <i>👁 ${esc(num(v.views))}${v.duration ? ` · ⏱ ${esc(v.duration)}` : ''}</i>`
        ].join('\n')).join('\n')
    ].join('\n');
}

function channelKeyboard(token, page, ch) {
    return paginated({
        items: ch.videos,
        page,
        perPage: PER_PAGE,
        render: (v, index) => btn(`${index + 1}. ${truncate(v.title, 32)}`, 'an', 'cv', token, index),
        navPrefix: ['an', 'cl', token],
        backTo: ['an', 'menu']
    });
}

async function runChannel(ctx, input) {
    const p = await ui.Progress.open(ctx, 'Analyzing channel');

    try {
        await p.stage('Analyzing channel', '<i>Reading uploads and stats…</i>');
        const data = await api.channelAnalyze(input);

        const ch = { ...data, videos: Array.isArray(data.videos) ? data.videos : [] };

        if (!ch.videos.length) {
            return p.finish(txt.channelCard(ch), kb([backRow('an', 'menu')]), { preview: !!ch.avatar });
        }

        const token = cache.put(ch);
        const view = channelKeyboard(token, 0, ch);
        return p.finish(channelListText(ch, 0, view.pages), view.markup, { preview: !!ch.avatar });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

function register() {
    router.onMany({
        'an:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'an:meta': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'metadata', back: ['an', 'menu'] });
        },

        'an:meta2': async (ctx, [token]) => {
            await ui.ack(ctx, '📊 Reading…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runMetadata(ctx, entry.url);
        },

        'an:thumb': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'thumbnail', back: ['an', 'menu'] });
        },

        'an:thumb2': async (ctx, [token]) => {
            await ui.ack(ctx, '🖼 Fetching…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runThumbnails(ctx, entry.url);
        },

        'an:tget': async (ctx, [token, index]) => {
            await ui.ack(ctx, '🖼 Sending…');

            const entry = cache.get(token);
            if (!entry) return ui.send(ctx, '⌛ That link expired.', menu());

            const thumb = index === 'd'
                ? { url: entry.thumbnail, width: 0, height: 0 }
                : (entry.thumbs || [])[parseInt(index, 10)];

            if (!thumb || !thumb.url) return ui.send(ctx, '⌛ That size is gone.', menu());

            const caption = [
                `🖼 <b>${esc(truncate(entry.title || 'Thumbnail', 70))}</b>`,
                thumb.width ? `<i>${thumb.width}×${thumb.height}</i>` : ''
            ].filter(Boolean).join('\n');

            // Telegram fetches the image itself — no round trip through the Pi.
            try {
                await ctx.replyWithDocument(
                    { url: thumb.url, filename: `thumbnail_${thumb.width || 'default'}.jpg` },
                    { caption, parse_mode: 'HTML' }
                );
            } catch (err) {
                await ctx.replyWithPhoto(thumb.url, { caption, parse_mode: 'HTML' });
            }

            return ui.send(ctx, '✅ Sent.', kb([[btn('◀️ Other sizes', 'an', 'thumb2', token)], [btn('🏠 Home', 'h', 'menu')]]));
        },

        'an:tagsfrom': async (ctx, [token]) => {
            await ui.ack(ctx, '🏷 Generating…');

            const entry = cache.get(token);
            if (!entry || !entry.title) return ui.send(ctx, '⌛ That link expired.', menu());

            const p = await ui.Progress.open(ctx, 'Generating tags');

            try {
                const data = await api.tags(entry.title);
                const tags = data.tags || [];

                return p.finish([
                    `🏷 <b>${esc(truncate(entry.title, 70))}</b>`,
                    txt.RULE,
                    '',
                    `<code>${esc(tags.join(', '))}</code>`,
                    '',
                    `<i>${tags.length} tags</i>`
                ].join('\n'), kb([backRow('an', 'menu')]));
            } catch (err) {
                return p.fail(router.explain(err), menu());
            }
        },

        'an:ch': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'Which channel?',
                hint: 'A @handle, a channel URL, or even a video link from it.',
                next: 'channel',
                back: ['an', 'menu']
            });
        },

        'an:cl': async (ctx, [token, page]) => {
            await ui.ack(ctx);

            const ch = cache.get(token);
            if (!ch) return ui.show(ctx, '⌛ That analysis expired.', menu());

            const view = channelKeyboard(token, parseInt(page, 10) || 0, ch);
            return ui.show(ctx, channelListText(ch, view.page, view.pages), view.markup, { preview: !!ch.avatar });
        },

        'an:cv': async (ctx, [token, index]) => {
            await ui.ack(ctx);

            const ch = cache.get(token);
            if (!ch) return ui.show(ctx, '⌛ That analysis expired.', menu());

            const video = ch.videos[parseInt(index, 10)];
            if (!video) return ui.show(ctx, '⌛ That video is gone.', menu());

            const page = Math.floor(parseInt(index, 10) / PER_PAGE);
            const videoModule = require('./video');
            return videoModule.showCard(ctx, {
                ...video,
                channel: ch.name,
                views: num(video.views)
            }, ['an', 'cl', token, page]);
        }
    });

    flow.onUrl('metadata', async (ctx, url) => runMetadata(ctx, url));
    flow.onUrl('thumbnail', async (ctx, url) => runThumbnails(ctx, url));
    flow.onText('channel', async (ctx, input) => runChannel(ctx, input));
}

module.exports = { register, menu };
