'use strict';

const router = require('./router');
const session = require('./session');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { kb, btn } = require('../ui/keyboards');
const { firstUrl, isUrl, esc } = require('../utils/format');

const urlHandlers = new Map();
const textHandlers = new Map();

const cancelRow = back => [
    back ? btn('◀️ Back', ...back) : btn('◀️ Back', 'h', 'menu'),
    btn('🏠 Home', 'h', 'menu')
];

/**
 * "Send me a link" prompts all behave the same, so they share one waiting state
 * and one validator. A feature only names the handler it wants the URL routed
 * to once the user types.
 */
function askUrl(ctx, { what = 'video', next, extra = {}, back = null, prompt = null } = {}) {
    session.setAwait(ctx.from.id, 'url', { next, extra });
    return ui.show(ctx, prompt || txt.askUrl(what), kb([cancelRow(back)]));
}

function askText(ctx, { prompt, hint, next, extra = {}, back = null } = {}) {
    session.setAwait(ctx.from.id, 'text', { next, extra });
    return ui.show(ctx, txt.ask(prompt, hint), kb([cancelRow(back)]));
}

function onUrl(name, handler) {
    urlHandlers.set(name, handler);
}

function onText(name, handler) {
    textHandlers.set(name, handler);
}

function normalizeUrl(raw) {
    const found = firstUrl(raw);
    if (found) return found.replace(/[)\].,]+$/, '');

    const trimmed = String(raw || '').trim();

    // Bare video ids and @handles are common enough to accept.
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return `https://www.youtube.com/watch?v=${trimmed}`;
    if (/^(www\.)?(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|vimeo\.com|pinterest\.com|snapchat\.com)\//i.test(trimmed)) {
        return `https://${trimmed.replace(/^www\./i, 'www.')}`;
    }

    return null;
}

function register() {
    router.onInput('url', async (ctx, text, data) => {
        const url = normalizeUrl(text);

        if (!url || !isUrl(url)) {
            session.setAwait(ctx.from.id, 'url', data);
            return ui.send(
                ctx,
                '🤔 <b>That does not look like a link</b>\n\nPaste a full URL starting with <code>http</code>, or tap Home to leave.',
                kb([cancelRow()])
            );
        }

        const handler = urlHandlers.get(data.next);
        if (!handler) {
            return ui.send(ctx, '⚠️ That step expired. Open the menu and start again.', kb([[btn('🏠 Home', 'h', 'menu')]]));
        }

        return handler(ctx, url, data.extra || {});
    });

    router.onInput('text', async (ctx, text, data) => {
        const handler = textHandlers.get(data.next);
        if (!handler) {
            return ui.send(ctx, '⚠️ That step expired. Open the menu and start again.', kb([[btn('🏠 Home', 'h', 'menu')]]));
        }

        const value = String(text || '').trim();
        if (!value) {
            session.setAwait(ctx.from.id, 'text', data);
            return ui.send(ctx, '⌨️ Send some text, or tap Home to leave.', kb([cancelRow()]));
        }

        return handler(ctx, value, data.extra || {});
    });
}

module.exports = { askUrl, askText, onUrl, onText, register, normalizeUrl, cancelRow, esc };
