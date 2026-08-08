'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const prefs = require('../services/prefs');
const { api, apiGet } = require('../api/client');
const { deliver } = require('../services/downloads');
const { kb, btn, optionRow, backRow } = require('../ui/keyboards');
const { esc, truncate, hhmmss, parseTime, hidden } = require('../utils/format');

const MAX_CLIP_SECONDS = 60;

const QUALITIES = [
    { value: '360', label: '360p' },
    { value: '480', label: '480p' },
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' }
];

const RATIOS = [
    { value: 'original', label: '🖥 Original' },
    { value: '9:16', label: '📱 9:16' },
    { value: '1:1', label: '⬜ 1:1' }
];

function menu() {
    return kb([
        [btn('✂️ Start a clip', 'c', 'ask')],
        [btn('🔥 Find a viral moment', 'a', 'viral')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '✂️ <b>Clip Studio</b>',
        txt.RULE,
        '',
        'Cut up to <b>60 seconds</b> out of any video and reframe it for shorts.',
        '',
        '<b>Original</b> — fastest, no re-encode',
        '<b>9:16</b> — vertical, ready for Shorts and Reels',
        '<b>1:1</b> — square, ready for feed posts',
        '',
        '<i>9:16 and 1:1 run through ffmpeg, so they take longer on a Pi.</i>'
    ].join('\n');
}

function builderText(job) {
    const hasRange = job.start !== null && job.end !== null;
    const length = hasRange ? job.end - job.start : 0;

    const lines = [
        `${job.thumbnail ? hidden(job.thumbnail) : ''}✂️ <b>${esc(truncate(job.title || 'Clip', 80))}</b>`,
        '',
        `<b>Start</b>   ${job.start === null ? '<i>not set</i>' : `<code>${hhmmss(job.start)}</code>`}`,
        `<b>End</b>     ${job.end === null ? '<i>not set</i>' : `<code>${hhmmss(job.end)}</code>`}`,
        `<b>Length</b>  ${hasRange ? `<code>${length}s</code>` : '—'}`,
        '',
        `<b>Quality</b> ${esc(job.quality)}p · <b>Frame</b> ${esc(job.ratio)}`
    ];

    if (hasRange && (length <= 0 || length > MAX_CLIP_SECONDS)) {
        lines.push('', `⚠️ <i>Length must be between 1 and ${MAX_CLIP_SECONDS} seconds.</i>`);
    } else if (hasRange) {
        lines.push('', '<i>Ready — tap Cut clip.</i>');
    } else {
        lines.push('', '<i>Set a start and an end time to continue.</i>');
    }

    return lines.join('\n');
}

function builderKeyboard(token, job) {
    const hasRange = job.start !== null && job.end !== null;
    const length = hasRange ? job.end - job.start : 0;
    const ready = hasRange && length > 0 && length <= MAX_CLIP_SECONDS;

    return kb([
        [btn('⏱ Set start', 'c', 'set', token, 'start'), btn('⏱ Set end', 'c', 'set', token, 'end')],
        [btn('⚡ First 30s', 'c', 'preset', token, '30'), btn('⚡ First 60s', 'c', 'preset', token, '60')],
        optionRow(QUALITIES, job.quality, 'c', 'q', token),
        optionRow(RATIOS, job.ratio, 'c', 'r', token),
        ready ? [btn('✂️ Cut clip', 'c', 'go', token)] : [btn('🔥 Let AI pick 30s', 'c', 'ai', token)],
        ready ? [btn('🔥 Let AI pick 30s', 'c', 'ai', token)] : null,
        backRow('c', 'menu')
    ].filter(Boolean));
}

function newJob(ctx, url, extra = {}) {
    const p = prefs.get(ctx.from.id);
    return {
        url,
        title: extra.title || '',
        thumbnail: extra.thumbnail || '',
        start: extra.start !== undefined ? extra.start : null,
        end: extra.end !== undefined ? extra.end : null,
        quality: p.clipQuality,
        ratio: p.clipRatio
    };
}

async function openBuilder(ctx, token) {
    const job = cache.get(token);
    if (!job) return ui.show(ctx, '⌛ <b>That clip session expired</b>\n\nStart again.', menu());
    return ui.show(ctx, builderText(job), builderKeyboard(token, job), { preview: !!job.thumbnail });
}

async function startBuilder(ctx, url, extra = {}) {
    const job = newJob(ctx, url, extra);

    // Title and thumbnail are cosmetic; a failure here must not block the clip.
    if (!job.title) {
        try {
            const info = await api.videoInfo(url);
            job.title = info.video?.title || '';
            job.thumbnail = info.video?.thumbnail || '';
        } catch (err) { /* keep the builder usable without metadata */ }
    }

    const token = cache.put(job);
    return ui.show(ctx, builderText(job), builderKeyboard(token, job), { preview: !!job.thumbnail });
}

async function pollJob(jobId, progress) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let ticks = 0;

    while (Date.now() < deadline) {
        await ui.sleep(ticks < 5 ? 3000 : 6000);
        ticks++;

        let status;
        try {
            status = await api.clipStatus(jobId);
        } catch (err) {
            if (err.status === 404) throw new Error('The clip job expired on the backend.');
            continue;
        }

        if (status.status === 'ready') return status;
        if (status.status === 'failed') throw new Error(status.error || 'Conversion failed.');

        await progress.note(`<i>ffmpeg is re-encoding… ${ticks * 4}s</i>`);
    }

    throw new Error('Conversion timed out.');
}

async function cut(ctx, token) {
    const job = cache.get(token);
    if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

    const length = job.end - job.start;
    if (!(length > 0 && length <= MAX_CLIP_SECONDS)) {
        return ui.alert(ctx, `The clip must be between 1 and ${MAX_CLIP_SECONDS} seconds.`);
    }

    const params = {
        url: job.url,
        start: job.start,
        end: job.end,
        quality: job.quality,
        ratio: job.ratio
    };

    const caption = [
        `✂️ <b>${esc(truncate(job.title || 'Clip', 80))}</b>`,
        `<i>${hhmmss(job.start)} → ${hhmmss(job.end)} · ${job.quality}p · ${esc(job.ratio)}</i>`
    ].join('\n');

    const backRows = kb([
        [btn('✂️ Another cut', 'c', 'open', token)],
        [btn('🏠 Home', 'h', 'menu')]
    ]);

    // ratio=original streams the file straight back; the reframed ratios are a
    // job the backend hands back as an id to poll.
    if (job.ratio === 'original') {
        return deliver(ctx, {
            apiPath: '/api/clip',
            params,
            kind: 'video',
            filenameHint: `${job.title || 'clip'}.mp4`,
            caption,
            label: 'Cutting clip',
            markup: backRows
        });
    }

    const p = await ui.Progress.open(ctx, 'Cutting clip');

    try {
        await p.stage('Cutting clip', '<i>Downloading the segment…</i>');
        const started = await apiGet('/api/clip', params);

        if (!started.jobId) throw new Error('The backend did not start a conversion job.');

        await p.stage('Reframing', `<i>Converting to ${job.ratio}…</i>`);
        const done = await pollJob(started.jobId, p);

        await p.stage('Fetching result', '');

        return deliver(ctx, {
            apiPath: `/api/clip/download/${encodeURIComponent(started.jobId)}`,
            params: {},
            kind: 'video',
            filenameHint: done.filename || `${job.title || 'clip'}.mp4`,
            caption,
            label: 'Fetching clip',
            progress: p,
            markup: backRows
        });
    } catch (err) {
        return p.fail(router.explain(err), backRows);
    }
}

function register() {
    router.onMany({
        'c:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'c:ask': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'clip', back: ['c', 'menu'] });
        },

        'c:load': async (ctx, [token]) => {
            await ui.ack(ctx);
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return startBuilder(ctx, entry.url, { title: entry.title, thumbnail: entry.thumbnail });
        },

        'c:open': async (ctx, [token]) => {
            await ui.ack(ctx);
            return openBuilder(ctx, token);
        },

        'c:set': async (ctx, [token, field]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

            return flow.askText(ctx, {
                prompt: field === 'start' ? 'Start time?' : 'End time?',
                hint: 'Formats: 90  ·  1:30  ·  0:01:30',
                next: 'clip_time',
                extra: { token, field },
                back: ['c', 'open', token]
            });
        },

        'c:preset': async (ctx, [token, seconds]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

            job.start = 0;
            job.end = parseInt(seconds, 10);
            return openBuilder(ctx, token);
        },

        'c:q': async (ctx, [token, value]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

            job.quality = value;
            prefs.set(ctx.from.id, 'clipQuality', value);
            return openBuilder(ctx, token);
        },

        'c:r': async (ctx, [token, ...rest]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

            // "9:16" contains the separator, so it arrives split across args.
            job.ratio = rest.join(':');
            prefs.set(ctx.from.id, 'clipRatio', job.ratio);
            return openBuilder(ctx, token);
        },

        'c:go': async (ctx, [token]) => {
            await ui.ack(ctx, '✂️ Cutting…');
            return cut(ctx, token);
        },

        'c:ai': async (ctx, [token]) => {
            await ui.ack(ctx, '🔥 Thinking…');

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

            const p = await ui.Progress.open(ctx, 'Reading the transcript');

            try {
                await p.stage('Finding the best 30s', '<i>The AI is scanning for a hook…</i>');
                const pick = await api.viral(job.url);

                job.start = Math.round(pick.startTime);
                job.end = Math.round(pick.endTime);
                if (!job.title) job.title = pick.title || '';
                if (!job.thumbnail) job.thumbnail = pick.thumbnail || '';

                const text = [
                    builderText(job),
                    '',
                    `🔥 <b>Why this moment</b>`,
                    `<i>${esc(truncate(pick.reasoning || '', 400))}</i>`
                ].join('\n');

                return p.finish(text, builderKeyboard(token, job), { preview: !!job.thumbnail });
            } catch (err) {
                return p.fail(router.explain(err), builderKeyboard(token, job));
            }
        }
    });

    flow.onUrl('clip', async (ctx, url) => startBuilder(ctx, url));

    flow.onText('clip_time', async (ctx, text, { token, field }) => {
        const job = cache.get(token);
        if (!job) return ui.send(ctx, '⌛ That clip session expired.', menu());

        const seconds = parseTime(text);

        if (seconds === null) {
            return flow.askText(ctx, {
                prompt: 'That time did not parse',
                hint: 'Try 90, 1:30 or 0:01:30.',
                next: 'clip_time',
                extra: { token, field },
                back: ['c', 'open', token]
            });
        }

        job[field] = seconds;

        // Setting a start with no end yet: assume a 30s clip, the user can edit.
        if (field === 'start' && job.end === null) job.end = seconds + 30;
        if (field === 'end' && job.start === null) job.start = Math.max(0, seconds - 30);

        return ui.send(ctx, builderText(job), builderKeyboard(token, job), { preview: !!job.thumbnail });
    });
}

module.exports = { register, menu, startBuilder };
