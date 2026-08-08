'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const prefs = require('../services/prefs');
const { api } = require('../api/client');
const { kb, btn, optionRow, backRow, grid } = require('../ui/keyboards');
const { esc, truncate, hidden, hhmmss } = require('../utils/format');

const SUMMARY_TYPES = [
    { value: 'brief', label: '📄 Brief' },
    { value: 'detailed', label: '📚 Detailed' },
    { value: 'keypoints', label: '🎯 Key points' },
    { value: 'chapters', label: '🕘 Chapters' }
];

const TITLE_STYLES = [
    { value: 'viral', label: '🔥 Viral' },
    { value: 'curiosity', label: '🤔 Curiosity' },
    { value: 'howto', label: '🛠 How-to' },
    { value: 'listicle', label: '🔢 Listicle' }
];

const DESC_TYPES = [
    { value: 'standard', label: '📄 Standard' },
    { value: 'detailed', label: '📚 Detailed' },
    { value: 'minimal', label: '✂️ Minimal' }
];

const DESC_OPTIONS = [
    { key: 'timestamps', label: '🕘 Timestamps' },
    { key: 'hashtags', label: '#️⃣ Hashtags' },
    { key: 'links', label: '🔗 Links' },
    { key: 'cta', label: '📣 Call to action' }
];

function menu() {
    return kb([
        [btn('🧠 Summarize a video', 'a', 'sum')],
        [btn('🔥 Find a viral moment', 'a', 'viral')],
        [btn('🏷 Generate tags', 'a', 'tags'), btn('✏️ Generate titles', 'a', 'titles')],
        [btn('📄 Write a description', 'a', 'desc')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '🧠 <b>AI Studio</b>',
        txt.RULE,
        '',
        '<b>Summarize</b> — four depths, from a paragraph to timed chapters',
        '<b>Viral moment</b> — the 30 seconds worth clipping, and why',
        '<b>Tags</b> — 15 searchable YouTube tags for any title',
        '<b>Titles</b> — 10 titles in the tone you pick',
        '<b>Description</b> — full SEO description with the sections you want'
    ].join('\n');
}

// --- Summaries -------------------------------------------------------------

function summaryTypeKeyboard(token, active) {
    return kb([
        ...grid(SUMMARY_TYPES.map(t => btn(`${t.value === active ? '✅ ' : ''}${t.label}`, 'a', 'type', token, t.value)), 2),
        backRow('a', 'menu')
    ]);
}

async function askSummaryType(ctx, url, progress) {
    const token = cache.put({ url });
    const active = prefs.get(ctx.from.id).summaryType;

    const text = [
        '🧠 <b>How deep should the summary go?</b>',
        '',
        `<code>${esc(truncate(url, 70))}</code>`,
        '',
        '<b>Brief</b> — 3-5 paragraphs, the main message',
        '<b>Detailed</b> — overview, main points, insights, conclusion',
        '<b>Key points</b> — a tight bulleted list',
        '<b>Chapters</b> — timestamped breakdown of every section'
    ].join('\n');

    if (progress) return progress.finish(text, summaryTypeKeyboard(token, active));
    return ui.show(ctx, text, summaryTypeKeyboard(token, active));
}

async function runSummary(ctx, token, type, refresh) {
    const entry = cache.get(token);
    if (!entry) return ui.send(ctx, '⌛ That link expired.', menu());

    prefs.set(ctx.from.id, 'summaryType', type);

    const p = await ui.Progress.open(ctx, 'Fetching the transcript');

    try {
        await p.stage('Summarizing', '<i>The model is reading the whole transcript…</i>');
        const data = await api.summarize(entry.url, type, refresh);

        const header = [
            `${data.thumbnail ? hidden(data.thumbnail) : ''}🧠 <b>${esc(truncate(data.title, 80))}</b>`,
            `<i>${esc(data.uploader || '')}${data.duration ? ` · ${esc(data.duration)}` : ''} · ${esc(type)}${data.cached ? ' · cached' : ''}</i>`,
            '',
            txt.RULE,
            ''
        ].join('\n');

        const markup = kb([
            ...grid(SUMMARY_TYPES.filter(t => t.value !== type).map(t => btn(t.label, 'a', 'type', token, t.value)), 2),
            [btn('🔄 Regenerate', 'a', 'refresh', token, type)],
            [btn('📚 Study kit', 'st', 'menu2', token), btn('💬 Chat about it', 'ch', 'load', token)],
            backRow('a', 'menu')
        ]);

        const body = header + esc(data.summary);

        if (body.length <= 3800) {
            return p.finish(body, markup, { preview: !!data.thumbnail });
        }

        await p.remove();
        return ui.sendLong(ctx, body, markup, { preview: !!data.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), kb([[btn('🔁 Try again', 'a', 'type', token, type)], backRow('a', 'menu')]));
    }
}

// --- Viral moment ----------------------------------------------------------

async function runViral(ctx, url) {
    const p = await ui.Progress.open(ctx, 'Scanning for a hook');

    try {
        await p.stage('Scanning for a hook', '<i>Reading the transcript with timings…</i>');
        const data = await api.viral(url);

        const clipToken = cache.put({
            url,
            title: data.title,
            thumbnail: data.thumbnail,
            start: Math.round(data.startTime),
            end: Math.round(data.endTime)
        });

        const text = [
            `${data.thumbnail ? hidden(data.thumbnail) : ''}🔥 <b>${esc(truncate(data.title, 80))}</b>`,
            '',
            `<b>Best 30 seconds</b>  <code>${hhmmss(data.startTime)} → ${hhmmss(data.endTime)}</code>`,
            `<b>Video length</b>     ${hhmmss(data.duration)}`,
            '',
            `<b>Why</b>`,
            `<i>${esc(truncate(data.reasoning || '', 600))}</i>`,
            '',
            `<b>What is said</b>`,
            `<code>${esc(truncate(data.clipTranscript || '', 700))}</code>`
        ].join('\n');

        const markup = kb([
            [btn('✂️ Cut this clip', 'c', 'load', clipToken)],
            [btn('🔄 Find another', 'a', 'viralagain', clipToken)],
            backRow('a', 'menu')
        ]);

        return p.finish(text, markup, { preview: !!data.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Descriptions ----------------------------------------------------------

function descText(job) {
    const on = DESC_OPTIONS.filter(o => job.options[o.key]).map(o => o.label).join(' · ') || 'none';

    return [
        '📄 <b>Description builder</b>',
        '',
        `<b>Title</b>     ${esc(truncate(job.title, 70))}`,
        `<b>Keywords</b>  ${job.keywords ? esc(truncate(job.keywords, 60)) : '<i>none</i>'}`,
        `<b>Length</b>    ${esc(job.type)}`,
        `<b>Include</b>   ${esc(on)}`,
        '',
        '<i>Toggle what you want, then generate.</i>'
    ].join('\n');
}

function descKeyboard(token, job) {
    return kb([
        ...grid(DESC_OPTIONS.map(o => btn(`${job.options[o.key] ? '✅' : '▫️'} ${o.label}`, 'a', 'dopt', token, o.key)), 2),
        optionRow(DESC_TYPES, job.type, 'a', 'dtype', token),
        [btn('🔤 Add keywords', 'a', 'dkw', token)],
        [btn('✨ Generate', 'a', 'dgo', token)],
        backRow('a', 'menu')
    ]);
}

function register() {
    router.onMany({
        'a:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'a:sum': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'summarize', back: ['a', 'menu'] });
        },

        'a:sum2': async (ctx, [token]) => {
            await ui.ack(ctx);
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return askSummaryType(ctx, entry.url);
        },

        'a:type': async (ctx, [token, type]) => {
            await ui.ack(ctx, '🧠 Working…');
            return runSummary(ctx, token, type, false);
        },

        'a:refresh': async (ctx, [token, type]) => {
            await ui.ack(ctx, '🔄 Regenerating…');
            return runSummary(ctx, token, type, true);
        },

        'a:viral': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'viral', back: ['a', 'menu'] });
        },

        'a:viral2': async (ctx, [token]) => {
            await ui.ack(ctx, '🔥 Scanning…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runViral(ctx, entry.url);
        },

        'a:viralagain': async (ctx, [token]) => {
            await ui.ack(ctx, '🔄 Scanning…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runViral(ctx, entry.url);
        },

        'a:tags': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What is the video called?',
                hint: 'Send the title and I will return 15 searchable tags.',
                next: 'tags',
                back: ['a', 'menu']
            });
        },

        'a:titles': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What is the video about?',
                hint: 'A topic works fine — "beginner sourdough", "React hooks".',
                next: 'titles_topic',
                back: ['a', 'menu']
            });
        },

        'a:tstyle': async (ctx, [token, style]) => {
            await ui.ack(ctx, '✏️ Writing…');

            const entry = cache.get(token);
            if (!entry) return ui.send(ctx, '⌛ That topic expired.', menu());

            prefs.set(ctx.from.id, 'titleStyle', style);
            const p = await ui.Progress.open(ctx, 'Writing titles');

            try {
                const data = await api.titles(entry.topic, style);
                const titles = data.titles || [];

                if (!titles.length) return p.finish('✏️ <b>Nothing came back</b>\n\nTry a more specific topic.', menu());

                const text = [
                    `✏️ <b>${esc(truncate(entry.topic, 70))}</b>`,
                    `<i>style: ${esc(style)}</i>`,
                    txt.RULE,
                    '',
                    titles.map((t, i) => `<b>${i + 1}.</b> ${esc(t)}`).join('\n\n')
                ].join('\n');

                const markup = kb([
                    ...grid(TITLE_STYLES.filter(s => s.value !== style).map(s => btn(s.label, 'a', 'tstyle', token, s.value)), 2),
                    backRow('a', 'menu')
                ]);

                return p.finish(text, markup);
            } catch (err) {
                return p.fail(router.explain(err), menu());
            }
        },

        'a:desc': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What is the video called?',
                hint: 'The description is built around this title.',
                next: 'desc_title',
                back: ['a', 'menu']
            });
        },

        'a:dopt': async (ctx, [token, key]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());

            job.options[key] = !job.options[key];
            return ui.show(ctx, descText(job), descKeyboard(token, job));
        },

        'a:dtype': async (ctx, [token, type]) => {
            await ui.ack(ctx);

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());

            job.type = type;
            prefs.set(ctx.from.id, 'descType', type);
            return ui.show(ctx, descText(job), descKeyboard(token, job));
        },

        'a:dkw': async (ctx, [token]) => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'Which keywords?',
                hint: 'Comma separated — they get woven in naturally.',
                next: 'desc_keywords',
                extra: { token },
                back: ['a', 'dback', token]
            });
        },

        'a:dback': async (ctx, [token]) => {
            await ui.ack(ctx);
            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());
            return ui.show(ctx, descText(job), descKeyboard(token, job));
        },

        'a:dgo': async (ctx, [token]) => {
            await ui.ack(ctx, '✨ Writing…');

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());

            const p = await ui.Progress.open(ctx, 'Writing the description');

            try {
                const data = await api.description({
                    title: job.title,
                    keywords: job.keywords,
                    type: job.type,
                    options: job.options
                });

                const body = [
                    `📄 <b>${esc(truncate(job.title, 70))}</b>`,
                    txt.RULE,
                    '',
                    esc(data.description || '')
                ].join('\n');

                const markup = kb([
                    [btn('🔄 Rewrite', 'a', 'dgo', token)],
                    [btn('✂️ Shorter', 'a', 'dmod', token, 'shorter'), btn('➕ Longer', 'a', 'dmod', token, 'longer')],
                    [btn('👔 Formal', 'a', 'dmod', token, 'formal'), btn('😊 Casual', 'a', 'dmod', token, 'casual')],
                    [btn('⚙️ Options', 'a', 'dback', token)],
                    backRow('a', 'menu')
                ]);

                if (body.length <= 3800) return p.finish(body, markup);

                await p.remove();
                return ui.sendLong(ctx, body, markup);
            } catch (err) {
                return p.fail(router.explain(err), descKeyboard(token, job));
            }
        },

        'a:dmod': async (ctx, [token, modifier]) => {
            await ui.ack(ctx, '✨ Adjusting…');

            const job = cache.get(token);
            if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());

            const p = await ui.Progress.open(ctx, 'Adjusting the description');

            try {
                const data = await api.description({
                    title: job.title,
                    keywords: job.keywords,
                    type: job.type,
                    options: job.options,
                    modifier
                });

                const body = [
                    `📄 <b>${esc(truncate(job.title, 70))}</b>`,
                    `<i>${esc(modifier)}</i>`,
                    txt.RULE,
                    '',
                    esc(data.description || '')
                ].join('\n');

                const markup = kb([
                    [btn('🔄 Rewrite', 'a', 'dgo', token)],
                    [btn('✂️ Shorter', 'a', 'dmod', token, 'shorter'), btn('➕ Longer', 'a', 'dmod', token, 'longer')],
                    [btn('👔 Formal', 'a', 'dmod', token, 'formal'), btn('😊 Casual', 'a', 'dmod', token, 'casual')],
                    backRow('a', 'menu')
                ]);

                if (body.length <= 3800) return p.finish(body, markup);

                await p.remove();
                return ui.sendLong(ctx, body, markup);
            } catch (err) {
                return p.fail(router.explain(err), descKeyboard(token, job));
            }
        }
    });

    flow.onUrl('summarize', async (ctx, url) => askSummaryType(ctx, url));
    flow.onUrl('viral', async (ctx, url) => runViral(ctx, url));

    flow.onText('tags', async (ctx, title) => {
        const p = await ui.Progress.open(ctx, 'Generating tags');

        try {
            const data = await api.tags(title);
            const tags = data.tags || [];

            if (!tags.length) return p.finish('🏷 <b>Nothing came back</b>\n\nTry a longer title.', menu());

            const text = [
                `🏷 <b>${esc(truncate(title, 70))}</b>`,
                txt.RULE,
                '',
                `<code>${esc(tags.join(', '))}</code>`,
                '',
                `<i>${tags.length} tags · tap the block above to copy.</i>`
            ].join('\n');

            return p.finish(text, kb([[btn('🔄 Regenerate', 'a', 'tags')], backRow('a', 'menu')]));
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });

    flow.onText('titles_topic', async (ctx, topic) => {
        const token = cache.put({ topic });
        const active = prefs.get(ctx.from.id).titleStyle;

        const text = [
            '✏️ <b>Pick a tone</b>',
            '',
            `<b>Topic</b>  ${esc(truncate(topic, 70))}`,
            '',
            '<b>Viral</b> — emotional hooks and urgency',
            '<b>Curiosity</b> — open a gap the viewer must close',
            '<b>How-to</b> — a concrete promise of a skill',
            '<b>Listicle</b> — numbers and brackets'
        ].join('\n');

        return ui.send(ctx, text, kb([
            ...grid(TITLE_STYLES.map(s => btn(`${s.value === active ? '✅ ' : ''}${s.label}`, 'a', 'tstyle', token, s.value)), 2),
            backRow('a', 'menu')
        ]));
    });

    flow.onText('desc_title', async (ctx, title) => {
        const job = {
            title,
            keywords: '',
            type: prefs.get(ctx.from.id).descType,
            options: { timestamps: true, hashtags: true, links: false, cta: true }
        };

        const token = cache.put(job);
        return ui.send(ctx, descText(job), descKeyboard(token, job));
    });

    flow.onText('desc_keywords', async (ctx, keywords, { token }) => {
        const job = cache.get(token);
        if (!job) return ui.send(ctx, '⌛ That builder expired.', menu());

        job.keywords = keywords;
        return ui.send(ctx, descText(job), descKeyboard(token, job));
    });
}

module.exports = { register, menu };
