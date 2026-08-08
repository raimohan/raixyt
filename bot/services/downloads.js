'use strict';

const fs = require('fs');

const { config } = require('../config');
const { downloadTo, api, buildUrl } = require('../api/client');
const { heavy } = require('../core/queue');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { kb, btn, homeRow } = require('../ui/keyboards');
const { safeUnlink, safeFilename } = require('../utils/fsx');
const { esc, bytes, truncate } = require('../utils/format');
const stats = require('./stats');
const log = require('../utils/logger').tag('dl');

function sendKind(ctx, kind, filePath, filename, extra) {
    const source = { source: fs.createReadStream(filePath), filename };

    if (kind === 'audio') return ctx.replyWithAudio(source, extra);
    if (kind === 'video') return ctx.replyWithVideo(source, { supports_streaming: true, ...extra });
    if (kind === 'photo') return ctx.replyWithPhoto(source, extra);
    return ctx.replyWithDocument(source, extra);
}

const CHAT_ACTION = { audio: 'upload_voice', video: 'upload_video', photo: 'upload_photo' };

/**
 * The whole "give me that file" pipeline: queue slot -> backend download with a
 * live progress bar -> Telegram upload -> temp cleanup.
 *
 * Telegram rejects bot uploads over 50 MB, so anything oversized is reported
 * with a direct link instead of being pushed through anyway.
 */
async function deliver(ctx, opts) {
    const {
        apiPath,
        params,
        kind = 'document',
        filenameHint,
        caption = '',
        markup,
        label = 'Downloading',
        progress,
        meta = {},
        directLink = null
    } = opts;

    const p = progress || await ui.Progress.open(ctx, 'Queued');
    const queued = heavy.projectedWait();

    if (queued > 0) {
        await p.stage('Queued', `<i>Position ${queued} — the Pi is finishing another job.</i>`);
    }

    return heavy.run(async () => {
        let result = null;

        try {
            await p.stage(label, '<i>Asking yt-dlp for the file…</i>');

            result = await downloadTo(apiPath, params, {
                filenameHint,
                maxBytes: config.maxUploadBytes,
                onProgress: (received, total) => p.transfer(received, total, label)
            });

            if (result.tooBig) {
                // Resolving a direct URL costs another yt-dlp spawn, so it only
                // happens once we know the file will not fit.
                let link = null;
                if (typeof directLink === 'function') {
                    await p.stage('Too large — finding a direct link', '');
                    link = await directLink();
                } else {
                    link = directLink;
                }

                await p.finish(
                    txt.tooBig(bytes(result.size), link),
                    markup || kb([homeRow()]),
                    { preview: false }
                );
                return { ok: false, reason: 'too_big' };
            }

            const filename = safeFilename(result.filename || filenameHint || 'file');

            await p.stage('Uploading to Telegram', `<i>${esc(bytes(result.size))}</i>`);
            await ui.typing(ctx, CHAT_ACTION[kind] || 'upload_document');

            const extra = {
                caption: truncate(caption, 1000),
                parse_mode: 'HTML',
                ...(meta.performer ? { performer: meta.performer } : {}),
                ...(meta.title ? { title: meta.title } : {}),
                ...(meta.duration ? { duration: meta.duration } : {}),
                ...(markup || {})
            };

            try {
                await sendKind(ctx, kind, result.path, filename, extra);
            } catch (err) {
                // Telegram is picky about containers; a document always works.
                log.warn(`send as ${kind} failed (${ui.describe(err)}) — retrying as document`);
                await sendKind(ctx, 'document', result.path, filename, extra);
            }

            stats.addBytes(result.size);
            await p.remove();

            return { ok: true, size: result.size, filename };
        } catch (err) {
            log.error(`deliver failed: ${ui.describe(err)}`);
            await p.fail(ui.describe(err), markup || kb([homeRow()]));
            return { ok: false, reason: 'error', error: err };
        } finally {
            if (result && result.path) safeUnlink(result.path);
        }
    });
}

// Best-effort direct URL for files Telegram will not carry.
async function directStreamLink(videoId) {
    try {
        const info = await api.videoStream(videoId, { hls: 1 });
        return info && info.url ? info.url : null;
    } catch (err) {
        log.debug(`no direct link for ${videoId}: ${ui.describe(err)}`);
        return null;
    }
}

/**
 * /api/music/stream answers with a redirect to the real CDN URL. The backend
 * address is loopback-only, so the Location header is the part worth handing to
 * a user — following it here keeps the link usable off the Pi.
 */
async function directAudioLink(id) {
    try {
        const res = await fetch(buildUrl('/api/music/stream', { id }), { redirect: 'manual' });
        const location = res.headers.get('location');
        return location && /^https?:\/\//i.test(location) ? location : null;
    } catch (err) {
        log.debug(`no direct audio link for ${id}: ${ui.describe(err)}`);
        return null;
    }
}

function retryRow(...data) {
    return [btn('🔁 Try again', ...data)];
}

module.exports = { deliver, directStreamLink, directAudioLink, retryRow };
