'use strict';

const { config } = require('../config');
const users = require('../services/users');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { btn, kb } = require('../ui/keyboards');
const { esc } = require('../utils/format');
const log = require('../utils/logger').tag('auth');

const GATE_REQUEST = 'gate:req';

function requestKeyboard() {
    return kb([[btn('🙋 Request access', 'gate', 'req')]]);
}

function ownerNotifyKeyboard(id) {
    return kb([
        [btn('✅ Approve', 'ow', 'approve', id), btn('⛔ Deny', 'ow', 'deny', id)],
        [btn('🚫 Block', 'ow', 'block', id)]
    ]);
}

async function notifyOwner(ctx, record) {
    const who = [
        '🙋 <b>Access request</b>',
        '',
        `<b>Name</b>      ${esc(record.name)}`,
        record.username ? `<b>Username</b>  @${esc(record.username)}` : null,
        `<b>User id</b>   <code>${record.id}</code>`
    ].filter(Boolean).join('\n');

    try {
        await ctx.telegram.sendMessage(config.ownerId, who, {
            parse_mode: 'HTML',
            ...ownerNotifyKeyboard(record.id)
        });
        return true;
    } catch (err) {
        log.warn(`Could not reach the owner (${config.ownerId}): ${ui.describe(err)}`);
        return false;
    }
}

async function handleRequest(ctx) {
    await ui.ack(ctx);

    const existing = users.getPending(ctx.from.id);
    if (existing) {
        return ui.show(ctx, '⏳ <b>Request already sent</b>\n\nThe owner has it — you will get a message the moment it is approved.', kb([]));
    }

    const record = users.addPending(ctx.from);
    if (!record) {
        return ui.show(ctx, '🔒 <b>Access unavailable</b>', kb([]));
    }

    const delivered = await notifyOwner(ctx, record);

    return ui.show(
        ctx,
        delivered
            ? '📨 <b>Request sent</b>\n\nThe owner has been notified. You will hear back here.'
            : '📨 <b>Request stored</b>\n\nThe owner could not be messaged right now, but the request is saved and will show up in their panel.',
        kb([])
    );
}

/**
 * Everything past this point is owner-or-approved only. Unapproved users get a
 * single door: a request button that pings the owner with approve/deny.
 */
module.exports = async function auth(ctx, next) {
    const from = ctx.from;
    if (!from || from.is_bot) return;

    if (users.isAllowed(from.id)) {
        users.touch(from);
        ctx.state.isOwner = users.isOwner(from.id);
        ctx.state.isAdmin = users.isAdmin(from.id);
        return next();
    }

    const data = ctx.callbackQuery && ctx.callbackQuery.data;

    if (data === GATE_REQUEST) return handleRequest(ctx);

    if (users.isBlocked(from.id)) {
        if (ctx.callbackQuery) return ui.ack(ctx, 'You no longer have access to this bot.', true);
        return;
    }

    log.debug(`Blocked ${from.id} (${from.username || from.first_name || '?'})`);

    if (ctx.callbackQuery) {
        await ui.ack(ctx);
        return ui.show(ctx, txt.denied(), requestKeyboard());
    }

    return ctx.reply(txt.denied(), { parse_mode: 'HTML', ...requestKeyboard() }).catch(() => {});
};

module.exports.notifyOwner = notifyOwner;
module.exports.requestKeyboard = requestKeyboard;
