'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const quick = require('../ui/quickmenu');
const { api } = require('../api/client');
const { kb, btn, paginated, backRow } = require('../ui/keyboards');
const { esc, truncate } = require('../utils/format');

const PER_PAGE = 5;

function menu() {
    return kb([
        [btn('🔍 Search videos', 'v', 'search')],
        [btn('🔗 Inspect a link', 'v', 'info')],
        [btn('📃 Open a playlist', 'v', 'pl')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '🎬 <b>Video</b>',
        txt.RULE,
        '',
        '<b>Search</b> — 15 results straight from YouTube',
        '<b>Inspect</b> — title, channel, views and every quality on offer',
        '<b>Playlist</b> — open a playlist and pick episodes one by one'
    ].join('\n');
}

function resultsKeyboard(token, page, bundle) {
    return paginated({
        items: bundle.results,
        page,
        perPage: PER_PAGE,
        render: (item, index) => btn(
            `${index + 1}. ${truncate(item.title, 34)}`,
            'v', 'pick', token, index
        ),
        navPrefix: ['v', 'list', token],
        backTo: ['v', 'menu']
    });
}

function resultsText(bundle, page, pages) {
    const head = bundle.kind === 'playlist'
        ? `📃 <b>${esc(truncate(bundle.title, 70))}</b>`
        : `🔍 <b>${esc(truncate(bundle.query, 60))}</b>`;

    return [
        head,
        txt.RULE,
        `${bundle.results.length} result${bundle.results.length === 1 ? '' : 's'} · page ${page + 1} of ${pages}`,
        '',
        bundle.results
            .slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
            .map((r, i) => `<b>${page * PER_PAGE + i + 1}.</b> ${esc(truncate(r.title, 62))}\n     <i>${esc(r.channel || r.artist || '—')}${r.duration ? ` · ${esc(r.duration)}` : ''}${r.views && r.views !== 'N/A' ? ` · ${esc(r.views)}` : ''}</i>`)
            .join('\n')
    ].join('\n');
}

async function showResults(ctx, token, page) {
    const bundle = cache.get(token);
    if (!bundle) {
        return ui.show(ctx, '⌛ <b>Those results expired</b>\n\nRun the search again.', menu());
    }

    const view = resultsKeyboard(token, page, bundle);
    return ui.show(ctx, resultsText(bundle, view.page, view.pages), view.markup);
}

// One card, every module reachable from it.
async function showCard(ctx, video, backData) {
    const token = cache.put({ url: video.url || video.webpage_url, title: video.title });
    const rows = quick.keyboard(token).reply_markup.inline_keyboard.slice(0, -1);
    rows.push(backData ? backRow(...backData) : [btn('🏠 Home', 'h', 'menu')]);

    return ui.show(ctx, txt.videoCard(video), { reply_markup: { inline_keyboard: rows } }, { preview: !!video.thumbnail });
}

function register() {
    router.onMany({
        'v:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'v:search': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What are you looking for?',
                hint: 'Type a title, topic or channel name.',
                next: 'video_search',
                back: ['v', 'menu']
            });
        },

        'v:info': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'video_info', back: ['v', 'menu'] });
        },

        'v:pl': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'playlist', next: 'video_playlist', back: ['v', 'menu'] });
        },

        'v:list': async (ctx, [token, page]) => {
            await ui.ack(ctx);
            return showResults(ctx, token, parseInt(page, 10) || 0);
        },

        'v:pick': async (ctx, [token, index]) => {
            await ui.ack(ctx);

            const bundle = cache.get(token);
            if (!bundle) return ui.show(ctx, '⌛ Those results expired.', menu());

            const item = bundle.results[parseInt(index, 10)];
            if (!item) return ui.show(ctx, '⌛ That entry is gone.', menu());

            const page = Math.floor(parseInt(index, 10) / PER_PAGE);
            return showCard(ctx, item, ['v', 'list', token, page]);
        }
    });

    flow.onText('video_search', async (ctx, query) => {
        const p = await ui.Progress.open(ctx, 'Searching YouTube');

        try {
            const data = await api.videoSearch(query);
            const results = data.results || [];

            if (!results.length) {
                return p.finish('🔍 <b>Nothing found</b>\n\nTry different words.', menu());
            }

            const token = cache.put({ kind: 'search', query, results });
            const view = resultsKeyboard(token, 0, { results });
            return p.finish(resultsText({ kind: 'search', query, results }, 0, view.pages), view.markup);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });

    flow.onUrl('video_info', async (ctx, url) => {
        const p = await ui.Progress.open(ctx, 'Reading video');

        try {
            const data = await api.videoInfo(url);
            const video = { ...data.video, url };
            await p.remove();
            return showCard(ctx, video, ['v', 'menu']);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });

    flow.onUrl('video_playlist', async (ctx, url) => {
        const p = await ui.Progress.open(ctx, 'Opening playlist');

        try {
            const data = await api.videoPlaylist(url);
            const results = data.results || [];

            if (!results.length) {
                return p.finish('📃 <b>Empty playlist</b>\n\nNothing public in there.', menu());
            }

            const bundle = { kind: 'playlist', title: data.title || 'Playlist', results };
            const token = cache.put(bundle);
            const view = resultsKeyboard(token, 0, bundle);
            return p.finish(resultsText(bundle, 0, view.pages), view.markup);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });
}

module.exports = { register, menu, showCard };
