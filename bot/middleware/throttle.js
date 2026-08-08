'use strict';

const { config } = require('../config');
const ui = require('../ui/render');

const buckets = new Map();

setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [id, b] of buckets) {
        if (b.windowStart < cutoff) buckets.delete(id);
    }
}, 120000).unref();

/**
 * Fixed-window limiter. A double-tapped button should never queue two yt-dlp
 * runs on a Pi, and a held-down button should not spam the API either.
 */
module.exports = async function throttle(ctx, next) {
    const id = ctx.from && ctx.from.id;
    if (!id) return next();

    const now = Date.now();
    let bucket = buckets.get(id);

    if (!bucket || now - bucket.windowStart > config.throttleWindowMs) {
        bucket = { windowStart: now, count: 0, warned: 0 };
        buckets.set(id, bucket);
    }

    bucket.count++;

    if (bucket.count > config.throttleMax) {
        if (ctx.callbackQuery) {
            await ui.ack(ctx, '⏳ Slow down a moment…');
        } else if (now - bucket.warned > 5000) {
            bucket.warned = now;
            await ctx.reply('⏳ Too fast — give me a second to catch up.').catch(() => {});
        }
        return;
    }

    return next();
};
