'use strict';

const fs = require('fs');
const log = require('../utils/logger').tag('ui');
const { chunk, esc, bar, bytes, hhmmss } = require('../utils/format');
const { config } = require('../config');
const { homeRow, kb } = require('./keyboards');

function baseExtra(markup, opts = {}) {
    return {
        parse_mode: 'HTML',
        disable_web_page_preview: !opts.preview,
        ...(markup || {}),
        ...(opts.raw || {})
    };
}

function describe(err) {
    return (err && (err.description || err.message)) || String(err);
}

function isBenign(err) {
    const d = describe(err);
    return /message is not modified|message to edit not found|query is too old|message can't be edited/i.test(d);
}

/**
 * The single way a screen gets painted: edits the message the button lives on
 * when there is one, otherwise sends a new one. Falls back to sending when the
 * source message cannot hold text (a photo card, an expired message).
 */
async function show(ctx, text, markup, opts = {}) {
    const extra = baseExtra(markup, opts);
    const body = text.length > 4000 ? text.slice(0, 3990) + '\n…' : text;

    if (ctx.callbackQuery && ctx.callbackQuery.message && !opts.forceNew) {
        try {
            return await ctx.editMessageText(body, extra);
        } catch (err) {
            if (/message is not modified/i.test(describe(err))) return null;
            log.debug(`edit failed, sending fresh: ${describe(err)}`);
        }
    }

    return ctx.reply(body, extra);
}

async function send(ctx, text, markup, opts = {}) {
    return ctx.reply(text.length > 4000 ? text.slice(0, 3990) + '\n…' : text, baseExtra(markup, opts));
}

// Long AI output: split on paragraph boundaries, keyboard rides the last part.
async function sendLong(ctx, text, markup, opts = {}) {
    const parts = chunk(text, 3600);
    let last = null;

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        last = await ctx.reply(parts[i], baseExtra(isLast ? markup : null, opts));
        if (!isLast) await sleep(120);
    }

    return last;
}

async function sendDoc(ctx, filePath, filename, caption, markup) {
    return ctx.replyWithDocument(
        { source: fs.createReadStream(filePath), filename },
        { caption, parse_mode: 'HTML', ...(markup || {}) }
    );
}

// Text that is too long even for chunking is nicer as a downloadable file.
async function sendTextFile(ctx, text, filename, caption, markup) {
    return ctx.replyWithDocument(
        { source: Buffer.from(text, 'utf8'), filename },
        { caption, parse_mode: 'HTML', ...(markup || {}) }
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ack(ctx, text, alert = false) {
    if (!ctx.callbackQuery) return;
    if (ctx.state && ctx.state.acked && !text) return;
    if (ctx.state) ctx.state.acked = true;

    try {
        await ctx.answerCbQuery(text, alert ? { show_alert: true } : undefined);
    } catch (err) {
        if (!isBenign(err)) log.debug(`answerCbQuery: ${describe(err)}`);
    }
}

async function toast(ctx, text) {
    return ack(ctx, text, false);
}

async function alert(ctx, text) {
    return ack(ctx, text, true);
}

async function error(ctx, message, markup) {
    const text = `⚠️ <b>Something went wrong</b>\n\n<code>${esc(message)}</code>`;
    return show(ctx, text, markup || kb([homeRow()]));
}

/**
 * Live status line for slow work.
 *
 * Telegram rate-limits edits, so updates are throttled and the spinner ticks
 * on its own timer — the caller just calls stage()/progress() whenever it has
 * news and never has to think about pacing.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Progress {
    constructor(ctx, messageId, chatId) {
        this.ctx = ctx;
        this.chatId = chatId;
        this.messageId = messageId;
        this.startedAt = Date.now();
        this.lastText = '';
        this.lastEditAt = 0;
        this.pendingText = null;
        this.timer = null;
        this.frame = 0;
        this.label = 'Working';
        this.detail = '';
        this.closed = false;
    }

    static async open(ctx, label = 'Working') {
        const text = `⠋ <b>${esc(label)}…</b>`;
        const msg = await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
        const p = new Progress(ctx, msg.message_id, msg.chat.id);
        p.label = label;
        p.lastText = text;
        p.startTicker();
        return p;
    }

    startTicker() {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.closed) return;
            this.frame = (this.frame + 1) % FRAMES.length;
            this._paint(this._compose());
        }, 3000);
        if (this.timer.unref) this.timer.unref();
    }

    _compose() {
        const spin = FRAMES[this.frame];
        const secs = Math.round((Date.now() - this.startedAt) / 1000);
        const clock = secs >= 5 ? `  <i>${hhmmss(secs)}</i>` : '';
        return `${spin} <b>${esc(this.label)}…</b>${clock}${this.detail ? `\n${this.detail}` : ''}`;
    }

    async _paint(text) {
        if (this.closed || text === this.lastText) return;

        const now = Date.now();
        if (now - this.lastEditAt < 2500) {
            this.pendingText = text;
            return;
        }

        this.lastEditAt = now;
        this.pendingText = null;
        this.lastText = text;

        try {
            await this.ctx.telegram.editMessageText(this.chatId, this.messageId, undefined, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (err) {
            if (!isBenign(err)) log.debug(`progress edit: ${describe(err)}`);
        }
    }

    stage(label, detail = '') {
        this.label = label;
        this.detail = detail;
        this.frame = 0;
        return this._paint(this._compose());
    }

    note(detail) {
        this.detail = detail;
        return this._paint(this._compose());
    }

    transfer(received, total, label) {
        const known = total && total > 0;
        const ratio = known ? received / total : 0;
        const size = known
            ? `${bytes(received)} / ${bytes(total)}`
            : bytes(received);

        this.label = label || this.label;
        this.detail = known
            ? `<code>${bar(ratio)}</code>  ${Math.round(ratio * 100)}%\n<i>${size}</i>`
            : `<i>${size} received</i>`;

        return this._paint(this._compose());
    }

    async finish(text, markup, opts = {}) {
        this.close();
        const extra = baseExtra(markup, opts);

        try {
            return await this.ctx.telegram.editMessageText(this.chatId, this.messageId, undefined, text, extra);
        } catch (err) {
            if (/message is not modified/i.test(describe(err))) return null;
            log.debug(`progress finish: ${describe(err)}`);
            return this.ctx.reply(text, extra);
        }
    }

    async fail(message, markup) {
        return this.finish(
            `⚠️ <b>Something went wrong</b>\n\n<code>${esc(message)}</code>`,
            markup || kb([homeRow()])
        );
    }

    async remove() {
        this.close();
        try {
            await this.ctx.telegram.deleteMessage(this.chatId, this.messageId);
        } catch (err) { /* already gone */ }
    }

    close() {
        this.closed = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

async function typing(ctx, action = 'typing') {
    try {
        await ctx.sendChatAction(action);
    } catch (err) { /* cosmetic */ }
}

module.exports = {
    show, send, sendLong, sendDoc, sendTextFile,
    ack, toast, alert, error, typing, sleep,
    Progress, describe, isBenign, baseExtra,
    limits: { maxUploadBytes: config.maxUploadBytes }
};
