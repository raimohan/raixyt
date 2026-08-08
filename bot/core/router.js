'use strict';

const log = require('../utils/logger').tag('router');
const session = require('./session');
const ui = require('../ui/render');
const stats = require('../services/stats');
const { esc } = require('../utils/format');
const { ApiError } = require('../api/client');

const callbacks = new Map();   // "ns:action" -> handler(ctx, args)
const inputs = new Map();      // awaiting type -> handler(ctx, text, data)
const documents = new Map();   // awaiting type -> handler(ctx, document, data)

let fallbackText = null;

function on(key, handler) {
    if (callbacks.has(key)) log.warn(`duplicate callback route: ${key}`);
    callbacks.set(key, handler);
}

function onMany(map) {
    for (const [key, handler] of Object.entries(map)) on(key, handler);
}

function onInput(type, handler) {
    inputs.set(type, handler);
}

function onDocument(type, handler) {
    documents.set(type, handler);
}

function setTextFallback(handler) {
    fallbackText = handler;
}

function parse(data) {
    const parts = String(data || '').split(':');
    return { ns: parts[0] || '', action: parts[1] || '', args: parts.slice(2) };
}

function explain(err) {
    if (err instanceof ApiError) return err.message;
    if (err && err.name === 'AbortError') return 'The operation timed out.';
    return (err && err.message) || 'Unexpected error';
}

async function guard(ctx, label, fn) {
    try {
        await fn();
    } catch (err) {
        stats.bumpError();
        log.error(`${label}: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
        if (err && err.stack) log.debug(err.stack);

        try {
            await ui.ack(ctx);
            await ui.send(ctx, `⚠️ <b>Could not finish that</b>\n\n<code>${esc(explain(err))}</code>`);
        } catch (nested) { /* the chat itself is unreachable */ }
    }
}

async function dispatchCallback(ctx, next) {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (!data) return next();

    const { ns, action, args } = parse(data);

    if (ns === 'h' && action === 'noop') {
        return ui.ack(ctx);
    }

    const handler = callbacks.get(`${ns}:${action}`);
    if (!handler) {
        // Usually a button from a message that predates a redeploy. A popup
        // alone would leave the user staring at a keyboard that does nothing.
        log.debug(`unknown route: ${ns}:${action}`);
        await ui.ack(ctx);

        const home = require('../features/home');
        return guard(ctx, 'unknown route', () => home.openHome(ctx));
    }

    stats.bump(`${ns}:${action}`);
    return guard(ctx, `cb ${ns}:${action}`, () => handler(ctx, args));
}

async function dispatchText(ctx, next) {
    const text = (ctx.message && ctx.message.text ? ctx.message.text : '').trim();
    if (!text) return next();

    const pending = session.peekAwait(ctx.from.id);

    if (pending) {
        const handler = inputs.get(pending.type);
        if (handler) {
            if (!pending.keep) session.clearAwait(ctx.from.id);
            stats.bump(`input:${pending.type}`);
            return guard(ctx, `input ${pending.type}`, () => handler(ctx, text, pending.data || {}));
        }
        session.clearAwait(ctx.from.id);
    }

    if (fallbackText) {
        return guard(ctx, 'text fallback', () => fallbackText(ctx, text));
    }

    return next();
}

async function dispatchDocument(ctx, next) {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return next();

    const pending = session.peekAwait(ctx.from.id);
    if (!pending) return next();

    const handler = documents.get(pending.type);
    if (!handler) return next();

    if (!pending.keep) session.clearAwait(ctx.from.id);
    stats.bump(`doc:${pending.type}`);
    return guard(ctx, `document ${pending.type}`, () => handler(ctx, doc, pending.data || {}));
}

module.exports = {
    on, onMany, onInput, onDocument, setTextFallback,
    dispatchCallback, dispatchText, dispatchDocument,
    guard, parse, explain,
    get routeCount() { return callbacks.size; }
};
