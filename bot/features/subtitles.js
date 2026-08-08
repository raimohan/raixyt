'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const prefs = require('../services/prefs');
const { api } = require('../api/client');
const { deliver } = require('../services/downloads');
const { kb, btn, paginated, backRow } = require('../ui/keyboards');
const { esc, truncate, hidden } = require('../utils/format');

const PER_PAGE = 8;

function menu() {
    return kb([
        [btn('📝 Load subtitles', 's', 'ask')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '📝 <b>Subtitles</b>',
        txt.RULE,
        '',
        'List every caption track on a video, preview it, and export it.',
        '',
        '<b>SRT</b> — timed, for video editors and players',
        '<b>VTT</b> — timed, for the web',
        '<b>TXT</b> — plain text, no timestamps'
    ].join('\n');
}

function trackListText(bundle, page, pages) {
    const slice = bundle.subtitles.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

    return [
        `${bundle.thumbnail ? hidden(bundle.thumbnail) : ''}📝 <b>${esc(truncate(bundle.title, 80))}</b>`,
        '',
        `👤 ${esc(bundle.uploader || '—')}${bundle.duration ? ` · ⏱ ${esc(bundle.duration)}` : ''}`,
        `🗣 ${bundle.subtitles.length} track${bundle.subtitles.length === 1 ? '' : 's'} · page ${page + 1} of ${pages}`,
        '',
        slice.map(s => `  ${s.auto ? '🤖' : '✍️'} <code>${esc(s.code)}</code>  ${esc(truncate(s.name, 40))}`).join('\n'),
        '',
        '<i>✍️ human-written · 🤖 auto-generated</i>'
    ].join('\n');
}

function trackListKeyboard(token, page, bundle) {
    return paginated({
        items: bundle.subtitles,
        page,
        perPage: PER_PAGE,
        render: (s, index) => btn(`${s.auto ? '🤖' : '✍️'} ${truncate(s.name, 26)}`, 's', 'lang', token, index),
        navPrefix: ['s', 'list', token],
        backTo: ['s', 'menu']
    });
}

function trackText(bundle, track) {
    return [
        `📝 <b>${esc(truncate(bundle.title, 80))}</b>`,
        '',
        `<b>Track</b>  ${esc(track.name)}`,
        `<b>Code</b>   <code>${esc(track.code)}</code>`,
        `<b>Type</b>   ${track.auto ? 'auto-generated' : 'human-written'}`,
        '',
        'Preview it, or export in the format you need.'
    ].join('\n');
}

function trackKeyboard(token, index) {
    return kb([
        [btn('👀 Preview', 's', 'prev', token, index)],
        [
            btn('⬇️ SRT', 's', 'get', token, index, 'srt'),
            btn('⬇️ VTT', 's', 'get', token, index, 'vtt'),
            btn('⬇️ TXT', 's', 'get', token, index, 'txt')
        ],
        backRow('s', 'list', token, Math.floor(index / PER_PAGE))
    ]);
}

async function load(ctx, url, progress) {
    const p = progress || await ui.Progress.open(ctx, 'Reading caption tracks');

    try {
        const data = await api.subtitles(url);
        const subtitles = data.subtitles || [];

        if (!subtitles.length) {
            return p.finish('📝 <b>No subtitles</b>\n\nThis video has no caption tracks at all.', menu());
        }

        const bundle = {
            url,
            title: data.title || 'Video',
            thumbnail: data.thumbnail || '',
            uploader: data.uploader || '',
            duration: data.duration || '',
            subtitles
        };

        const token = cache.put(bundle);
        const view = trackListKeyboard(token, 0, bundle);
        return p.finish(trackListText(bundle, 0, view.pages), view.markup, { preview: !!bundle.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

function register() {
    router.onMany({
        's:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        's:ask': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'subs', back: ['s', 'menu'] });
        },

        's:load': async (ctx, [token]) => {
            await ui.ack(ctx, '📝 Loading…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return load(ctx, entry.url);
        },

        's:list': async (ctx, [token, page]) => {
            await ui.ack(ctx);

            const bundle = cache.get(token);
            if (!bundle) return ui.show(ctx, '⌛ Those tracks expired.', menu());

            const view = trackListKeyboard(token, parseInt(page, 10) || 0, bundle);
            return ui.show(ctx, trackListText(bundle, view.page, view.pages), view.markup, { preview: !!bundle.thumbnail });
        },

        's:lang': async (ctx, [token, index]) => {
            await ui.ack(ctx);

            const bundle = cache.get(token);
            if (!bundle) return ui.show(ctx, '⌛ Those tracks expired.', menu());

            const track = bundle.subtitles[parseInt(index, 10)];
            if (!track) return ui.show(ctx, '⌛ That track is gone.', menu());

            return ui.show(ctx, trackText(bundle, track), trackKeyboard(token, parseInt(index, 10)));
        },

        's:prev': async (ctx, [token, index]) => {
            await ui.ack(ctx, '👀 Loading preview…');

            const bundle = cache.get(token);
            if (!bundle) return ui.send(ctx, '⌛ Those tracks expired.', menu());

            const track = bundle.subtitles[parseInt(index, 10)];
            if (!track) return ui.send(ctx, '⌛ That track is gone.', menu());

            const p = await ui.Progress.open(ctx, 'Fetching transcript');

            try {
                const data = await api.subtitlePreview(bundle.url, track.code);
                const lines = data.transcript || [];

                if (!lines.length) {
                    return p.finish('📝 <b>Empty track</b>\n\nNothing came back for that language.', trackKeyboard(token, parseInt(index, 10)));
                }

                const body = lines
                    .slice(0, 45)
                    .map(l => `<code>${esc(l.time)}</code>  ${esc(l.text)}`)
                    .join('\n');

                const text = [
                    `👀 <b>${esc(track.name)} preview</b>`,
                    txt.RULE,
                    '',
                    body,
                    '',
                    `<i>Showing ${Math.min(45, lines.length)} of ${lines.length} lines.</i>`
                ].join('\n');

                return p.finish(text, trackKeyboard(token, parseInt(index, 10)));
            } catch (err) {
                return p.fail(router.explain(err), trackKeyboard(token, parseInt(index, 10)));
            }
        },

        's:get': async (ctx, [token, index, format]) => {
            await ui.ack(ctx, '⬇️ Exporting…');

            const bundle = cache.get(token);
            if (!bundle) return ui.send(ctx, '⌛ Those tracks expired.', menu());

            const track = bundle.subtitles[parseInt(index, 10)];
            if (!track) return ui.send(ctx, '⌛ That track is gone.', menu());

            prefs.set(ctx.from.id, 'subFormat', format);

            return deliver(ctx, {
                apiPath: '/api/subtitles/download',
                params: { url: bundle.url, lang: track.code, format },
                kind: 'document',
                filenameHint: `${bundle.title} [${track.code}].${format}`,
                caption: `📝 <b>${esc(truncate(bundle.title, 70))}</b>\n<i>${esc(track.name)} · ${esc(format.toUpperCase())}</i>`,
                label: `Exporting ${format.toUpperCase()}`,
                markup: kb([backRow('s', 'lang', token, index)])
            });
        }
    });

    flow.onUrl('subs', async (ctx, url) => load(ctx, url));
}

module.exports = { register, menu, load };
