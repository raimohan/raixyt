'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { config } = require('../config');
const router = require('../core/router');
const flow = require('../core/flow');
const session = require('../core/session');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const users = require('../services/users');
const stats = require('../services/stats');
const { api } = require('../api/client');
const { heavy } = require('../core/queue');
const { kb, btn, paginated, backRow, grid } = require('../ui/keyboards');
const { esc, truncate, bytes, hhmmss } = require('../utils/format');
const { ensureDir, safeUnlink } = require('../utils/fsx');
const log = require('../utils/logger').tag('admin');

const PER_PAGE = 6;

function menu() {
    return kb([
        [btn('👥 Users', 'ow', 'users'), btn('🙋 Requests', 'ow', 'pending')],
        [btn('➕ Add user', 'ow', 'add'), btn('🚫 Blocked', 'ow', 'blocked')],
        [btn('🍪 Cookies', 'ow', 'cookies'), btn('❤️ Health', 'ow', 'health')],
        [btn('📈 Statistics', 'ow', 'stats'), btn('📢 Broadcast', 'ow', 'bc')],
        [btn('♻️ Restart services', 'ow', 'restart')],
        [btn('🏠 Home', 'h', 'menu')]
    ]);
}

function menuText() {
    const c = users.counts();

    return [
        '🛠 <b>Owner Panel</b>',
        txt.RULE,
        '',
        `<b>Users</b>     ${c.total} approved · ${c.admins} admin`,
        `<b>Pending</b>   ${c.pending} request${c.pending === 1 ? '' : 's'}`,
        `<b>Blocked</b>   ${c.blocked}`,
        '',
        `<b>API</b>       <code>${esc(config.apiBase)}</code>`,
        `<b>Cookies</b>   <code>${esc(config.cookiesDir)}</code>`,
        '',
        c.pending ? '⚠️ <i>There are access requests waiting.</i>' : '<i>Everything is quiet.</i>'
    ].join('\n');
}

// Every route in this module is owner/admin only, no exceptions.
function guarded(handler) {
    return async (ctx, args) => {
        if (!users.isAdmin(ctx.from.id)) {
            return ui.ack(ctx, 'That panel is owner-only.', true);
        }
        return handler(ctx, args);
    };
}

// --- Users -----------------------------------------------------------------

function roleIcon(role) {
    return role === 'owner' ? '👑' : role === 'admin' ? '🛡' : '👤';
}

function usersText(list, page, pages) {
    const slice = list.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

    return [
        '👥 <b>Approved users</b>',
        txt.RULE,
        `${list.length} total · page ${page + 1} of ${pages}`,
        '',
        slice.map(u => [
            `${roleIcon(u.role)} <b>${esc(truncate(u.name, 30))}</b>${u.username ? ` @${esc(u.username)}` : ''}`,
            `     <code>${u.id}</code> · ${u.uses || 0} actions${u.lastSeen ? ` · seen ${esc(String(u.lastSeen).slice(0, 10))}` : ''}`
        ].join('\n')).join('\n'),
        '',
        '<i>Tap a user to manage them.</i>'
    ].join('\n');
}

function usersKeyboard(page, list) {
    return paginated({
        items: list,
        page,
        perPage: PER_PAGE,
        render: u => btn(`${roleIcon(u.role)} ${truncate(u.name, 24)}`, 'ow', 'u', u.id),
        navPrefix: ['ow', 'users'],
        extraRows: [[btn('➕ Add user', 'ow', 'add')]],
        backTo: ['ow', 'menu']
    });
}

function userDetailText(u) {
    return [
        `${roleIcon(u.role)} <b>${esc(u.name)}</b>`,
        txt.RULE,
        '',
        `<b>User id</b>   <code>${u.id}</code>`,
        u.username ? `<b>Username</b>  @${esc(u.username)}` : null,
        `<b>Role</b>      ${esc(u.role)}`,
        `<b>Added</b>     ${esc(String(u.addedAt).slice(0, 16).replace('T', ' '))}`,
        `<b>Last seen</b> ${u.lastSeen ? esc(String(u.lastSeen).slice(0, 16).replace('T', ' ')) : 'never'}`,
        `<b>Actions</b>   ${u.uses || 0}`
    ].filter(Boolean).join('\n');
}

function userDetailKeyboard(u) {
    if (u.role === 'owner') {
        return kb([[btn('◀️ Back', 'ow', 'users', 0)], [btn('🏠 Home', 'h', 'menu')]]);
    }

    return kb([
        u.role === 'admin'
            ? [btn('⬇️ Demote to user', 'ow', 'demote', u.id)]
            : [btn('⬆️ Promote to admin', 'ow', 'promote', u.id)],
        [btn('🗑 Revoke access', 'ow', 'rm', u.id), btn('🚫 Block', 'ow', 'block', u.id)],
        backRow('ow', 'users', 0)
    ]);
}

// --- Cookies ---------------------------------------------------------------

function cookieStatus() {
    return Object.entries(config.cookieFiles).map(([platform, filename]) => {
        const full = path.join(config.cookiesDir, filename);

        try {
            if (!fs.existsSync(full)) return { platform, filename, exists: false };

            const st = fs.statSync(full);
            const content = fs.readFileSync(full, 'utf8');
            const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

            return {
                platform,
                filename,
                exists: true,
                size: st.size,
                cookies: lines.length,
                updated: st.mtime.toISOString()
            };
        } catch (err) {
            return { platform, filename, exists: false, error: err.message };
        }
    });
}

function cookiesText() {
    const rows = cookieStatus().map(c => {
        if (!c.exists) return `❌ <b>${esc(c.platform)}</b>  <i>not uploaded</i>`;
        if (!c.cookies) return `⚠️ <b>${esc(c.platform)}</b>  <i>file is empty — yt-dlp will abort</i>`;
        return [
            `✅ <b>${esc(c.platform)}</b>  ${c.cookies} cookies · ${esc(bytes(c.size))}`,
            `     <i>updated ${esc(String(c.updated).slice(0, 16).replace('T', ' '))}</i>`
        ].join('\n');
    });

    return [
        '🍪 <b>Cookie files</b>',
        txt.RULE,
        '',
        rows.join('\n'),
        '',
        `<b>Folder</b>  <code>${esc(config.cookiesDir)}</code>`,
        '',
        '<b>How to export</b>',
        'Use a "Get cookies.txt LOCALLY" browser extension while logged in, then send me the file.',
        '',
        '<i>youtube.txt is also what the backend uses for X, TikTok, Facebook, Vimeo, Pinterest and Snapchat.</i>'
    ].join('\n');
}

function cookiesKeyboard() {
    const status = cookieStatus();

    const uploadButtons = Object.keys(config.cookieFiles).map(p =>
        btn(`⬆️ Upload ${p}`, 'ow', 'ckup', p)
    );

    const deleteButtons = status
        .filter(c => c.exists)
        .map(c => btn(`🗑 Delete ${c.platform}`, 'ow', 'ckdel', c.platform));

    return kb([
        ...grid(uploadButtons, 2),
        ...(deleteButtons.length ? grid(deleteButtons, 2) : []),
        [btn('🔄 Refresh', 'ow', 'cookies'), btn('❤️ Backend view', 'ow', 'health')],
        backRow('ow', 'menu')
    ]);
}

function validateCookieFile(content) {
    const lines = content.split(/\r?\n/);
    const dataLines = lines.filter(l => l.trim() && !l.trim().startsWith('#'));
    const netscapeLines = dataLines.filter(l => l.split('\t').length >= 6);

    if (!dataLines.length) {
        return { ok: false, reason: 'The file has no cookie lines in it.' };
    }
    if (!netscapeLines.length) {
        return {
            ok: false,
            reason: 'This is not Netscape cookie format. Export with a "cookies.txt" extension, not a JSON exporter.'
        };
    }

    return { ok: true, count: netscapeLines.length };
}

// --- Restart ---------------------------------------------------------------

function pm2Restart(name) {
    return new Promise((resolve, reject) => {
        execFile('pm2', ['restart', name], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').trim().slice(0, 300)));
            resolve(String(stdout).trim());
        });
    });
}

function register() {
    router.onMany({
        'ow:menu': guarded(async ctx => {
            await ui.ack(ctx);
            session.clearAwait(ctx.from.id);
            return ui.show(ctx, menuText(), menu());
        }),

        'ow:users': guarded(async (ctx, [page]) => {
            await ui.ack(ctx);

            const list = users.list();
            const view = usersKeyboard(parseInt(page, 10) || 0, list);
            return ui.show(ctx, usersText(list, view.page, view.pages), view.markup);
        }),

        'ow:u': guarded(async (ctx, [id]) => {
            await ui.ack(ctx);

            const user = users.list().find(u => String(u.id) === String(id));
            if (!user) return ui.show(ctx, '🤷 That user is no longer on the list.', menu());

            return ui.show(ctx, userDetailText(user), userDetailKeyboard(user));
        }),

        'ow:add': guarded(async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'Which user id?',
                hint: 'Send the numeric Telegram id. They can find it by sending /id to this bot.',
                next: 'admin_add',
                back: ['ow', 'menu']
            });
        }),

        'ow:rm': guarded(async (ctx, [id]) => {
            const removed = users.remove(id);
            await ui.ack(ctx, removed ? '🗑 Access revoked' : 'Nothing to revoke');

            const list = users.list();
            const view = usersKeyboard(0, list);
            return ui.show(ctx, usersText(list, view.page, view.pages), view.markup);
        }),

        'ow:block': guarded(async (ctx, [id]) => {
            users.block(id);
            await ui.ack(ctx, '🚫 Blocked');

            const list = users.list();
            const view = usersKeyboard(0, list);
            return ui.show(ctx, usersText(list, view.page, view.pages), view.markup);
        }),

        'ow:unblock': guarded(async (ctx, [id]) => {
            users.unblock(id);
            await ui.ack(ctx, '✅ Unblocked');

            const blocked = users.listBlocked();
            return ui.show(ctx, blockedText(blocked), blockedKeyboard(blocked));
        }),

        'ow:promote': guarded(async (ctx, [id]) => {
            if (!users.isOwner(ctx.from.id)) return ui.ack(ctx, 'Only the owner can change roles.', true);

            users.add(id, { role: 'admin' });
            await ui.ack(ctx, '⬆️ Promoted to admin');

            const user = users.list().find(u => String(u.id) === String(id));
            return ui.show(ctx, userDetailText(user), userDetailKeyboard(user));
        }),

        'ow:demote': guarded(async (ctx, [id]) => {
            if (!users.isOwner(ctx.from.id)) return ui.ack(ctx, 'Only the owner can change roles.', true);

            users.add(id, { role: 'user' });
            await ui.ack(ctx, '⬇️ Demoted');

            const user = users.list().find(u => String(u.id) === String(id));
            return ui.show(ctx, userDetailText(user), userDetailKeyboard(user));
        }),

        'ow:pending': guarded(async ctx => {
            await ui.ack(ctx);

            const pending = users.listPending();

            if (!pending.length) {
                return ui.show(ctx, '🙋 <b>No pending requests</b>\n\nEveryone who asked has been dealt with.', kb([backRow('ow', 'menu')]));
            }

            const text = [
                '🙋 <b>Access requests</b>',
                txt.RULE,
                '',
                pending.map(p => [
                    `<b>${esc(truncate(p.name, 30))}</b>${p.username ? ` @${esc(p.username)}` : ''}`,
                    `     <code>${p.id}</code> · ${esc(String(p.at).slice(0, 16).replace('T', ' '))}`
                ].join('\n')).join('\n')
            ].join('\n');

            const rows = pending.slice(0, 8).map(p => [
                btn(`✅ ${truncate(p.name, 14)}`, 'ow', 'approve', p.id),
                btn('⛔', 'ow', 'deny', p.id),
                btn('🚫', 'ow', 'block', p.id)
            ]);

            return ui.show(ctx, text, kb([...rows, backRow('ow', 'menu')]));
        }),

        'ow:approve': guarded(async (ctx, [id]) => {
            const pending = users.getPending(id);
            users.add(id, pending ? { name: pending.name, username: pending.username } : {});
            users.dropPending(id);

            await ui.ack(ctx, '✅ Approved');

            try {
                await ctx.telegram.sendMessage(
                    id,
                    '🎉 <b>You are in</b>\n\nThe owner approved your request. Send /start to open the menu.',
                    { parse_mode: 'HTML' }
                );
            } catch (err) {
                log.warn(`Could not notify ${id}: ${ui.describe(err)}`);
            }

            return ui.show(ctx, `✅ <b>Approved</b>\n\n<code>${esc(String(id))}</code> can now use the bot.`, kb([
                [btn('🙋 More requests', 'ow', 'pending')],
                backRow('ow', 'menu')
            ]));
        }),

        'ow:deny': guarded(async (ctx, [id]) => {
            users.dropPending(id);
            await ui.ack(ctx, '⛔ Denied');

            return ui.show(ctx, `⛔ <b>Denied</b>\n\n<code>${esc(String(id))}</code> was not added.`, kb([
                [btn('🙋 More requests', 'ow', 'pending')],
                backRow('ow', 'menu')
            ]));
        }),

        'ow:blocked': guarded(async ctx => {
            await ui.ack(ctx);
            const blocked = users.listBlocked();
            return ui.show(ctx, blockedText(blocked), blockedKeyboard(blocked));
        }),

        'ow:cookies': guarded(async ctx => {
            await ui.ack(ctx);
            session.clearAwait(ctx.from.id);
            return ui.show(ctx, cookiesText(), cookiesKeyboard());
        }),

        'ow:ckup': guarded(async (ctx, [platform]) => {
            await ui.ack(ctx);

            session.setAwait(ctx.from.id, 'cookie_upload', { platform });

            return ui.show(ctx, [
                `⬆️ <b>Send the ${esc(platform)} cookie file</b>`,
                '',
                `Attach it as a <b>document</b> (not as text). It will be saved as <code>${esc(config.cookieFiles[platform])}</code> in the backend folder.`,
                '',
                '<b>Export it with</b>',
                '• Chrome/Edge — "Get cookies.txt LOCALLY" extension',
                '• Firefox — "cookies.txt" extension',
                '',
                '<i>Log in first, open the site, then export. Netscape format only.</i>'
            ].join('\n'), kb([backRow('ow', 'cookies')]));
        }),

        'ow:ckdel': guarded(async (ctx, [platform]) => {
            const filename = config.cookieFiles[platform];
            if (!filename) return ui.ack(ctx, 'Unknown platform.', true);

            safeUnlink(path.join(config.cookiesDir, filename));
            await ui.ack(ctx, '🗑 Deleted');

            return ui.show(ctx, cookiesText(), cookiesKeyboard());
        }),

        'ow:health': guarded(async ctx => {
            await ui.ack(ctx, '❤️ Checking…');

            const p = await ui.Progress.open(ctx, 'Pinging the backend');

            try {
                const health = await api.health();
                return p.finish(txt.healthCard(health), kb([
                    [btn('🔄 Refresh', 'ow', 'health'), btn('🍪 Cookies', 'ow', 'cookies')],
                    backRow('ow', 'menu')
                ]));
            } catch (err) {
                return p.fail(router.explain(err), kb([
                    [btn('🔄 Retry', 'ow', 'health'), btn('♻️ Restart API', 'ow', 'rst', 'api')],
                    backRow('ow', 'menu')
                ]));
            }
        }),

        'ow:stats': guarded(async ctx => {
            await ui.ack(ctx);

            const snapshot = stats.snapshot();
            const sys = {
                uptime: process.uptime(),
                rss: process.memoryUsage().rss,
                sessions: session.size,
                queueActive: heavy.active,
                queueWaiting: heavy.waiting
            };

            return ui.show(ctx, txt.statsCard(snapshot, sys), kb([
                [btn('🔄 Refresh', 'ow', 'stats')],
                backRow('ow', 'menu')
            ]));
        }),

        'ow:bc': guarded(async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What should everyone receive?',
                hint: 'Sent to every approved user. HTML formatting works.',
                next: 'admin_broadcast',
                back: ['ow', 'menu']
            });
        }),

        'ow:bcgo': guarded(async (ctx, [token]) => {
            await ui.ack(ctx, '📢 Sending…');

            const payload = cache.get(token);
            if (!payload) return ui.send(ctx, '⌛ That draft expired.', menu());

            const recipients = users.list().filter(u => u.id !== ctx.from.id);
            const p = await ui.Progress.open(ctx, 'Broadcasting');

            let sent = 0;
            let failed = 0;

            for (const user of recipients) {
                try {
                    await ctx.telegram.sendMessage(user.id, payload.text, { parse_mode: 'HTML' });
                    sent++;
                } catch (err) {
                    failed++;
                }
                await ui.sleep(60);
                await p.note(`<i>${sent + failed} / ${recipients.length}</i>`);
            }

            return p.finish([
                '📢 <b>Broadcast finished</b>',
                '',
                `✅ Delivered  ${sent}`,
                `❌ Failed     ${failed}`
            ].join('\n'), kb([backRow('ow', 'menu')]));
        }),

        'ow:restart': guarded(async ctx => {
            await ui.ack(ctx);

            return ui.show(ctx, [
                '♻️ <b>Restart services</b>',
                txt.RULE,
                '',
                `<b>${esc(config.pm2ApiName)}</b> — the yt-dlp + AI backend`,
                `<b>${esc(config.pm2BotName)}</b> — this bot`,
                '',
                '<i>Restarting the bot drops this conversation for a few seconds.</i>'
            ].join('\n'), kb([
                [btn(`♻️ Restart ${config.pm2ApiName}`, 'ow', 'rst', 'api')],
                [btn(`♻️ Restart ${config.pm2BotName}`, 'ow', 'rst', 'bot')],
                backRow('ow', 'menu')
            ]));
        }),

        'ow:rst': guarded(async (ctx, [target]) => {
            if (!users.isOwner(ctx.from.id)) return ui.ack(ctx, 'Only the owner can restart services.', true);

            await ui.ack(ctx, '♻️ Restarting…');

            const name = target === 'bot' ? config.pm2BotName : config.pm2ApiName;
            const p = await ui.Progress.open(ctx, `Restarting ${name}`);

            try {
                await pm2Restart(name);

                if (target === 'bot') {
                    return p.finish(`♻️ <b>${esc(name)} restarting</b>\n\nGive it a few seconds, then send /start.`, kb([]));
                }

                await ui.sleep(3000);

                try {
                    const health = await api.health();
                    return p.finish(`✅ <b>${esc(name)} is back</b>\n\n${txt.healthCard(health)}`, kb([backRow('ow', 'menu')]));
                } catch (err) {
                    return p.finish(`♻️ <b>${esc(name)} restarted</b>\n\n<i>It is not answering yet — check again in a moment.</i>`, kb([
                        [btn('❤️ Health', 'ow', 'health')],
                        backRow('ow', 'menu')
                    ]));
                }
            } catch (err) {
                return p.fail(`pm2 could not restart ${name}: ${ui.describe(err)}`, kb([backRow('ow', 'menu')]));
            }
        })
    });

    flow.onText('admin_add', async (ctx, value) => {
        if (!users.isAdmin(ctx.from.id)) return;

        const id = parseInt(String(value).replace(/[^\d]/g, ''), 10);

        if (!id || String(id).length < 5) {
            return flow.askText(ctx, {
                prompt: 'That is not a user id',
                hint: 'A Telegram id is a number like 123456789.',
                next: 'admin_add',
                back: ['ow', 'menu']
            });
        }

        users.add(id, {});

        try {
            await ctx.telegram.sendMessage(
                id,
                '🎉 <b>Access granted</b>\n\nThe owner added you to this bot. Send /start to begin.',
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            log.warn(`Added ${id} but could not message them: ${ui.describe(err)}`);
        }

        const list = users.list();
        const view = usersKeyboard(0, list);

        return ui.send(ctx, `✅ <b>Added <code>${id}</code></b>\n\n${usersText(list, view.page, view.pages)}`, view.markup);
    });

    flow.onText('admin_broadcast', async (ctx, text) => {
        if (!users.isAdmin(ctx.from.id)) return;

        const token = cache.put({ text });
        const recipients = users.list().filter(u => u.id !== ctx.from.id).length;

        return ui.send(ctx, [
            '📢 <b>Preview</b>',
            txt.RULE,
            '',
            text,
            '',
            txt.RULE,
            `<i>Goes out to ${recipients} user${recipients === 1 ? '' : 's'}.</i>`
        ].join('\n'), kb([
            [btn('📤 Send it', 'ow', 'bcgo', token)],
            [btn('✏️ Rewrite', 'ow', 'bc')],
            backRow('ow', 'menu')
        ]));
    });

    router.onDocument('cookie_upload', async (ctx, doc, { platform }) => {
        if (!users.isAdmin(ctx.from.id)) return;

        const filename = config.cookieFiles[platform];
        if (!filename) return ui.send(ctx, '⚠️ Unknown platform.', cookiesKeyboard());

        if (doc.file_size > 5 * 1024 * 1024) {
            return ui.send(ctx, '⚠️ <b>That file is far too large</b>\n\nA cookie export is a few kilobytes.', cookiesKeyboard());
        }

        const p = await ui.Progress.open(ctx, 'Reading the file');

        try {
            const link = await ctx.telegram.getFileLink(doc.file_id);
            const res = await fetch(String(link));

            if (!res.ok) throw new Error(`Telegram returned ${res.status} for that file`);

            const content = await res.text();
            const check = validateCookieFile(content);

            if (!check.ok) {
                return p.fail(check.reason, cookiesKeyboard());
            }

            ensureDir(config.cookiesDir);
            const target = path.join(config.cookiesDir, filename);
            fs.writeFileSync(target, content, { mode: 0o600 });

            log.ok(`${platform} cookies written to ${target} (${check.count} cookies)`);

            return p.finish([
                '✅ <b>Cookies installed</b>',
                '',
                `<b>Platform</b>  ${esc(platform)}`,
                `<b>Saved as</b>  <code>${esc(filename)}</code>`,
                `<b>Cookies</b>   ${check.count}`,
                '',
                '<i>The backend picks the file up on the next request — no restart needed.</i>'
            ].join('\n'), cookiesKeyboard());
        } catch (err) {
            return p.fail(ui.describe(err), cookiesKeyboard());
        }
    });
}

function blockedText(blocked) {
    if (!blocked.length) {
        return '🚫 <b>Nobody is blocked</b>';
    }

    return [
        '🚫 <b>Blocked users</b>',
        txt.RULE,
        '',
        blocked.map(b => `<code>${b.id}</code> · ${esc(String(b.at).slice(0, 16).replace('T', ' '))}`).join('\n')
    ].join('\n');
}

function blockedKeyboard(blocked) {
    const rows = blocked.slice(0, 10).map(b => [btn(`✅ Unblock ${b.id}`, 'ow', 'unblock', b.id)]);
    return kb([...rows, backRow('ow', 'menu')]);
}

module.exports = { register, menu, menuText };
