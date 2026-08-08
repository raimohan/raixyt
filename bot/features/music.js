'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { api } = require('../api/client');
const { deliver, directAudioLink } = require('../services/downloads');
const { kb, btn, paginated, backRow } = require('../ui/keyboards');
const { esc, truncate, hidden } = require('../utils/format');

const PER_PAGE = 5;
const BATCH_LIMIT = 5;

function menu() {
    return kb([
        [btn('🔍 Search a song', 'm', 'search')],
        [btn('📃 Import a playlist', 'm', 'pl')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '🎵 <b>Music</b>',
        txt.RULE,
        '',
        'Highest-quality MP3 with cover art and metadata embedded.',
        '',
        '<b>Search</b> — top 10 matches for any song',
        '<b>Playlist</b> — pull a whole YouTube playlist, track by track'
    ].join('\n');
}

function listKeyboard(token, page, bundle) {
    const extraRows = bundle.kind === 'playlist' && bundle.results.length > 1
        ? [[btn(`⚡ Grab first ${Math.min(BATCH_LIMIT, bundle.results.length)}`, 'm', 'batch', token)]]
        : [];

    return paginated({
        items: bundle.results,
        page,
        perPage: PER_PAGE,
        render: (item, index) => btn(`⬇️ ${index + 1}. ${truncate(item.title, 30)}`, 'm', 'get', token, index),
        navPrefix: ['m', 'list', token],
        extraRows,
        backTo: ['m', 'menu']
    });
}

function listText(bundle, page, pages) {
    const head = bundle.kind === 'playlist'
        ? `📃 <b>${esc(truncate(bundle.title, 70))}</b>`
        : `🎧 <b>${esc(truncate(bundle.query, 60))}</b>`;

    const rows = bundle.results
        .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
        .map((r, i) => `<b>${page * PER_PAGE + i + 1}.</b> ${esc(truncate(r.title, 58))}\n     <i>${esc(r.artist || '—')}${r.duration ? ` · ${esc(r.duration)}` : ''}</i>`)
        .join('\n');

    return [
        head,
        txt.RULE,
        `${bundle.results.length} track${bundle.results.length === 1 ? '' : 's'} · page ${page + 1} of ${pages}`,
        '',
        rows,
        '',
        '<i>Tap a track to receive it as MP3.</i>'
    ].join('\n');
}

async function showList(ctx, token, page) {
    const bundle = cache.get(token);
    if (!bundle) return ui.show(ctx, '⌛ <b>Those results expired</b>\n\nSearch again.', menu());

    const view = listKeyboard(token, page, bundle);
    return ui.show(ctx, listText(bundle, view.page, view.pages), view.markup);
}

async function grab(ctx, track, backData, progress) {
    const caption = [
        `${track.thumbnail ? hidden(track.thumbnail) : ''}🎵 <b>${esc(truncate(track.title, 80))}</b>`,
        `👤 ${esc(track.artist || 'Unknown artist')}`
    ].join('\n');

    return deliver(ctx, {
        apiPath: '/api/music/download',
        params: { id: track.id || track.url, title: track.title, artist: track.artist },
        kind: 'audio',
        filenameHint: `${track.title || 'track'}.mp3`,
        caption,
        label: 'Ripping audio',
        progress,
        meta: { title: track.title, performer: track.artist },
        markup: kb([backData ? backData : [btn('🏠 Home', 'h', 'menu')]]),
        directLink: () => directAudioLink(track.id || track.url)
    });
}

function register() {
    router.onMany({
        'm:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'm:search': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'Which song?',
                hint: 'Song name, or "artist - title" for a tighter match.',
                next: 'music_search',
                back: ['m', 'menu']
            });
        },

        'm:pl': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'playlist', next: 'music_playlist', back: ['m', 'menu'] });
        },

        'm:list': async (ctx, [token, page]) => {
            await ui.ack(ctx);
            return showList(ctx, token, parseInt(page, 10) || 0);
        },

        'm:get': async (ctx, [token, index]) => {
            await ui.ack(ctx, '⬇️ Starting…');

            const bundle = cache.get(token);
            if (!bundle) return ui.send(ctx, '⌛ Those results expired.', menu());

            const track = bundle.results[parseInt(index, 10)];
            if (!track) return ui.send(ctx, '⌛ That track is gone.', menu());

            const page = Math.floor(parseInt(index, 10) / PER_PAGE);
            return grab(ctx, track, [btn('◀️ Back to list', 'm', 'list', token, page)]);
        },

        'm:batch': async (ctx, [token]) => {
            await ui.ack(ctx, '⚡ Queued');

            const bundle = cache.get(token);
            if (!bundle) return ui.send(ctx, '⌛ Those results expired.', menu());

            const tracks = bundle.results.slice(0, BATCH_LIMIT);
            await ui.send(ctx, `⚡ <b>Queued ${tracks.length} tracks</b>\n\nThey arrive one by one — the Pi handles them in order.`, kb([]));

            for (const track of tracks) {
                await grab(ctx, track, [btn('◀️ Back to list', 'm', 'list', token, 0)]);
            }

            return ui.send(ctx, '✅ <b>Batch finished</b>', kb([[btn('◀️ Back to list', 'm', 'list', token, 0)], [btn('🏠 Home', 'h', 'menu')]]));
        }
    });

    flow.onText('music_search', async (ctx, query) => {
        const p = await ui.Progress.open(ctx, 'Searching music');

        try {
            const data = await api.musicSearch(query);
            const results = data.results || [];

            if (!results.length) return p.finish('🎵 <b>No tracks found</b>\n\nTry another spelling.', menu());

            const bundle = { kind: 'search', query, results };
            const token = cache.put(bundle);
            const view = listKeyboard(token, 0, bundle);
            return p.finish(listText(bundle, 0, view.pages), view.markup);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });

    flow.onUrl('music_playlist', async (ctx, url) => {
        const p = await ui.Progress.open(ctx, 'Reading playlist');

        try {
            const data = await api.musicPlaylist(url);
            const results = data.results || [];

            if (!results.length) return p.finish('📃 <b>Empty playlist</b>', menu());

            const bundle = { kind: 'playlist', title: data.title || 'Playlist', results };
            const token = cache.put(bundle);
            const view = listKeyboard(token, 0, bundle);
            return p.finish(listText(bundle, 0, view.pages), view.markup);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });
}

module.exports = { register, menu };
