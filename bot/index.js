'use strict';

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');

const { config, validate, ensureDirs } = require('./config');
const log = require('./utils/logger');
const { sweep } = require('./utils/fsx');

const router = require('./core/router');
const flow = require('./core/flow');
const session = require('./core/session');

const throttle = require('./middleware/throttle');
const auth = require('./middleware/auth');

const users = require('./services/users');
const stats = require('./services/stats');

const ui = require('./ui/render');
const { kb, btn } = require('./ui/keyboards');

const features = [
    require('./features/home'),
    require('./features/video'),
    require('./features/music'),
    require('./features/downloader'),
    require('./features/clip'),
    require('./features/subtitles'),
    require('./features/ai'),
    require('./features/study'),
    require('./features/chat'),
    require('./features/analytics'),
    require('./features/course'),
    require('./features/settings'),
    require('./features/admin')
];

const home = features[0];

const COMMANDS = [
    { command: 'start', description: 'Open the main menu' },
    { command: 'menu', description: 'Back to the main menu' },
    { command: 'id', description: 'Show your Telegram id' }
];

function fail(problems) {
    log.error('The bot cannot start:');
    for (const problem of problems) log.error(`  • ${problem}`);
    log.error('');
    log.error(`Edit ${config.root}/.env and try again.`);
    process.exit(1);
}

async function main() {
    const problems = validate();
    if (problems.length) fail(problems);

    ensureDirs();
    users.load();

    const bot = new Telegraf(config.botToken, {
        handlerTimeout: config.handlerTimeoutMs
    });

    bot.catch((err, ctx) => {
        stats.bumpError();
        log.error(`Unhandled error on ${ctx && ctx.updateType}: ${ui.describe(err)}`);
        if (err && err.stack) log.debug(err.stack);
    });

    bot.use(throttle);

    // /id answers before the access gate, so a new user can find the number the
    // owner needs to approve them.
    bot.command('id', async ctx => {
        const lines = [
            '🪪 <b>Your Telegram id</b>',
            '',
            `<code>${ctx.from.id}</code>`,
            '',
            users.isOwner(ctx.from.id)
                ? '👑 You are the owner of this bot.'
                : users.isAllowed(ctx.from.id)
                    ? '✅ You have access.'
                    : 'ℹ️ Send this number to the owner to request access.'
        ];

        if (ctx.chat && ctx.chat.id !== ctx.from.id) {
            lines.push('', `<b>Chat id</b>  <code>${ctx.chat.id}</code>`);
        }

        return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    });

    bot.use(auth);

    bot.start(ctx => home.start(ctx));
    bot.command('menu', ctx => home.start(ctx));

    bot.command('cancel', async ctx => {
        session.clearAwait(ctx.from.id);
        return ctx.reply('✖️ Cancelled.', { parse_mode: 'HTML', ...kb([[btn('🏠 Home', 'h', 'menu')]]) });
    });

    flow.register();
    for (const feature of features) feature.register();

    bot.on('callback_query', router.dispatchCallback);
    bot.on(message('document'), router.dispatchDocument);
    bot.on(message('text'), router.dispatchText);

    // Anything else (photos, stickers, voice) gets a nudge rather than silence.
    bot.on('message', async ctx => {
        if (!session.peekAwait(ctx.from.id)) {
            return ui.send(
                ctx,
                '🤔 <b>I work with links and buttons</b>\n\nSend a video link, or open the menu.',
                kb([[btn('🏠 Open menu', 'h', 'menu')]])
            );
        }
    });

    setInterval(() => {
        const removed = sweep(config.tmpDir, 30 * 60 * 1000);
        if (removed) log.debug(`swept ${removed} stale temp file(s)`);
    }, 15 * 60 * 1000).unref();

    let me;
    try {
        me = await bot.telegram.getMe();
    } catch (err) {
        log.error(`Telegram rejected the token: ${ui.describe(err)}`);
        log.error('Check BOT_TOKEN in .env — get a fresh one from @BotFather if needed.');
        process.exit(1);
    }

    try {
        await bot.telegram.setMyCommands(COMMANDS);
    } catch (err) {
        log.warn(`Could not publish the command list: ${ui.describe(err)}`);
    }

    bot.launch({ dropPendingUpdates: config.dropPendingUpdates }).catch(err => {
        log.error(`Polling stopped: ${ui.describe(err)}`);
        process.exit(1);
    });

    log.ok(`@${me.username} is live`);
    log.info(`Owner        ${config.ownerId}`);
    log.info(`Approved     ${users.counts().total} user(s)`);
    log.info(`Backend      ${config.apiBase}`);
    log.info(`Cookies      ${config.cookiesDir}`);
    log.info(`Temp         ${config.tmpDir}`);
    log.info(`Routes       ${router.routeCount} · concurrency ${config.maxConcurrentJobs} · upload cap ${config.maxUploadMb} MB`);

    const stop = signal => {
        log.info(`${signal} — shutting down`);
        try { bot.stop(signal); } catch (err) { /* already stopping */ }
        users.saveNow();
        process.exit(0);
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    process.on('unhandledRejection', reason => {
        stats.bumpError();
        log.error(`Unhandled rejection: ${reason && reason.stack ? reason.stack.split('\n')[0] : reason}`);
    });

    process.on('uncaughtException', err => {
        stats.bumpError();
        log.error(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
    });
}

main().catch(err => {
    log.error(`Startup failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});
