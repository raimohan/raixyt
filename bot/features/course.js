'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const study = require('./study');
const { api } = require('../api/client');
const { kb, btn, paginated, backRow } = require('../ui/keyboards');
const { esc, truncate, hhmmss, hidden } = require('../utils/format');

const PER_PAGE = 6;

function menu() {
    return kb([
        [btn('🔎 Find a course', 'co', 'search')],
        [btn('🔗 Load a playlist or channel', 'co', 'resolve')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '🎓 <b>Courses</b>',
        txt.RULE,
        '',
        'Turn any playlist or channel into an ordered course with real durations.',
        '',
        '<b>Find</b> — search YouTube for ready-made playlists',
        '<b>Load</b> — paste a playlist link, a channel link or an @handle',
        '',
        '<i>Once loaded you can open any lesson, or ask for a study plan.</i>'
    ].join('\n');
}

// --- Search ----------------------------------------------------------------

function searchListText(bundle, page, pages) {
    const slice = bundle.results.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

    return [
        `🔎 <b>${esc(truncate(bundle.query, 60))}</b>`,
        txt.RULE,
        `${bundle.results.length} playlist${bundle.results.length === 1 ? '' : 's'} · page ${page + 1} of ${pages}`,
        '',
        slice.map((r, i) => [
            `<b>${page * PER_PAGE + i + 1}.</b> ${esc(truncate(r.title, 58))}`,
            `     <i>${esc(r.author || '—')}${r.videoCount ? ` · ${r.videoCount} videos` : ''}</i>`
        ].join('\n')).join('\n')
    ].join('\n');
}

function searchKeyboard(token, page, bundle) {
    return paginated({
        items: bundle.results,
        page,
        perPage: PER_PAGE,
        render: (r, index) => btn(`${index + 1}. ${truncate(r.title, 32)}`, 'co', 'pick', token, index),
        navPrefix: ['co', 'sl', token],
        backTo: ['co', 'menu']
    });
}

// --- Resolved course -------------------------------------------------------

function courseText(course, page, pages) {
    const slice = course.videos.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

    return [
        txt.courseCard(course),
        '',
        txt.RULE,
        `<b>Lessons</b> · page ${page + 1} of ${pages}`,
        '',
        slice.map((v, i) => `<b>${page * PER_PAGE + i + 1}.</b> ${esc(truncate(v.title, 56))}  <i>${hhmmss(v.durationSec)}</i>`).join('\n')
    ].join('\n');
}

function courseKeyboard(token, page, course) {
    return paginated({
        items: course.videos,
        page,
        perPage: PER_PAGE,
        render: (v, index) => btn(`${index + 1}. ${truncate(v.title, 30)}`, 'co', 'lesson', token, index),
        navPrefix: ['co', 'll', token],
        extraRows: [[btn('🗓 Build a study plan', 'co', 'plan', token)]],
        backTo: ['co', 'menu']
    });
}

async function resolve(ctx, input, progress) {
    const p = progress || await ui.Progress.open(ctx, 'Loading the course');

    try {
        await p.stage('Loading the course', '<i>Reading every lesson and its duration…</i>');
        const data = await api.courseResolve(input);

        const course = { ...data, videos: Array.isArray(data.videos) ? data.videos : [] };

        if (!course.videos.length) {
            return p.finish('🎓 <b>Nothing in there</b>\n\nNo public videos were found.', menu());
        }

        const token = cache.put(course);
        const view = courseKeyboard(token, 0, course);
        return p.finish(courseText(course, 0, view.pages), view.markup, { preview: !!course.thumbUrl });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

function register() {
    router.onMany({
        'co:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'co:search': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What do you want to learn?',
                hint: 'e.g. "class 12 physics gravitation", "rust for beginners"',
                next: 'course_search',
                back: ['co', 'menu']
            });
        },

        'co:resolve': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'Playlist, channel or @handle?',
                hint: 'A playlist URL, a channel URL, or just @channelname',
                next: 'course_resolve',
                back: ['co', 'menu']
            });
        },

        'co:sl': async (ctx, [token, page]) => {
            await ui.ack(ctx);

            const bundle = cache.get(token);
            if (!bundle) return ui.show(ctx, '⌛ Those results expired.', menu());

            const view = searchKeyboard(token, parseInt(page, 10) || 0, bundle);
            return ui.show(ctx, searchListText(bundle, view.page, view.pages), view.markup);
        },

        'co:pick': async (ctx, [token, index]) => {
            await ui.ack(ctx, '🎓 Loading…');

            const bundle = cache.get(token);
            if (!bundle) return ui.send(ctx, '⌛ Those results expired.', menu());

            const item = bundle.results[parseInt(index, 10)];
            if (!item) return ui.send(ctx, '⌛ That playlist is gone.', menu());

            return resolve(ctx, item.url);
        },

        'co:ll': async (ctx, [token, page]) => {
            await ui.ack(ctx);

            const course = cache.get(token);
            if (!course) return ui.show(ctx, '⌛ That course expired.', menu());

            const view = courseKeyboard(token, parseInt(page, 10) || 0, course);
            return ui.show(ctx, courseText(course, view.page, view.pages), view.markup, { preview: !!course.thumbUrl });
        },

        'co:lesson': async (ctx, [token, index]) => {
            await ui.ack(ctx);

            const course = cache.get(token);
            if (!course) return ui.show(ctx, '⌛ That course expired.', menu());

            const lesson = course.videos[parseInt(index, 10)];
            if (!lesson) return ui.show(ctx, '⌛ That lesson is gone.', menu());

            const page = Math.floor(parseInt(index, 10) / PER_PAGE);
            const videoModule = require('./video');

            return videoModule.showCard(ctx, {
                title: lesson.title,
                channel: course.author,
                duration: hhmmss(lesson.durationSec),
                thumbnail: lesson.thumbUrl,
                url: `https://www.youtube.com/watch?v=${lesson.id}`,
                description: lesson.description
            }, ['co', 'll', token, page]);
        },

        'co:plan': async (ctx, [token]) => {
            await ui.ack(ctx);

            const course = cache.get(token);
            if (!course) return ui.send(ctx, '⌛ That course expired.', menu());

            return flow.askText(ctx, {
                prompt: 'What is your goal?',
                hint: 'e.g. "finish before my exam in 3 weeks", "1 hour a day"',
                next: 'course_goal',
                extra: { token },
                back: ['co', 'll', token, 0]
            });
        }
    });

    flow.onText('course_search', async (ctx, query) => {
        const p = await ui.Progress.open(ctx, 'Searching playlists');

        try {
            const data = await api.courseSearch(query);
            const results = data.results || [];

            if (!results.length) return p.finish('🔎 <b>No playlists found</b>\n\nTry broader words.', menu());

            const bundle = { query, results };
            const token = cache.put(bundle);
            const view = searchKeyboard(token, 0, bundle);
            return p.finish(searchListText(bundle, 0, view.pages), view.markup);
        } catch (err) {
            return p.fail(router.explain(err), menu());
        }
    });

    flow.onText('course_resolve', async (ctx, input) => resolve(ctx, input));

    flow.onText('course_goal', async (ctx, goal, { token }) => {
        const course = cache.get(token);
        if (!course) return ui.send(ctx, '⌛ That course expired.', menu());

        return study.runPlan(ctx, goal, course.videoCount || course.videos.length, course.totalDurationSec || 0);
    });
}

module.exports = { register, menu, resolve };
