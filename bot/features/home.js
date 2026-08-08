'use strict';

const router = require('../core/router');
const session = require('../core/session');
const cache = require('../core/cache');
const flow = require('../core/flow');
const ui = require('../ui/render');
const txt = require('../ui/text');
const quick = require('../ui/quickmenu');
const users = require('../services/users');
const { kb, btn } = require('../ui/keyboards');

function mainMenu(ctx) {
    const rows = [
        [btn('🎬 Video', 'v', 'menu'), btn('🎵 Music', 'm', 'menu')],
        [btn('⬇️ Downloader', 'd', 'menu'), btn('✂️ Clip Studio', 'c', 'menu')],
        [btn('🧠 AI Studio', 'a', 'menu'), btn('📚 Study', 'st', 'menu')],
        [btn('📝 Subtitles', 's', 'menu'), btn('💬 Video Chat', 'ch', 'menu')],
        [btn('📊 Insights', 'an', 'menu'), btn('🎓 Courses', 'co', 'menu')],
        [btn('⚙️ Settings', 'cf', 'menu'), btn('❓ Help', 'h', 'help')]
    ];

    if (users.isAdmin(ctx.from.id)) {
        rows.push([btn('🛠 Owner Panel', 'ow', 'menu')]);
    }

    return kb(rows);
}

async function openHome(ctx) {
    session.clearAwait(ctx.from.id);
    return ui.show(ctx, txt.home(ctx.from), mainMenu(ctx));
}

async function start(ctx) {
    session.reset(ctx.from.id);
    return ui.send(ctx, txt.home(ctx.from), mainMenu(ctx));
}

function register() {
    router.onMany({
        'h:menu': async ctx => {
            await ui.ack(ctx);
            return openHome(ctx);
        },

        'h:help': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, txt.help(), kb([[btn('🏠 Home', 'h', 'menu')]]));
        },

        'h:close': async ctx => {
            await ui.ack(ctx);
            try {
                await ctx.deleteMessage();
            } catch (err) {
                await ui.show(ctx, '👋 Closed. Send /menu to come back.', kb([]));
            }
        }
    });

    // Anything typed with no prompt open: a link becomes a quick-action card,
    // anything else nudges back to the menu.
    router.setTextFallback(async (ctx, text) => {
        const url = flow.normalizeUrl(text);

        if (url) {
            const token = cache.put({ url });
            return ui.send(ctx, quick.card(url), quick.keyboard(token));
        }

        return ui.send(
            ctx,
            '👋 <b>Tap your way around</b>\n\nSend a video link, or open the menu below.',
            kb([[btn('🏠 Open menu', 'h', 'menu')], [btn('❓ Help', 'h', 'help')]])
        );
    });
}

module.exports = { register, start, openHome, mainMenu };
