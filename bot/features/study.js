'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { api } = require('../api/client');
const { kb, btn, backRow } = require('../ui/keyboards');
const { esc, truncate, bar, hhmmss } = require('../utils/format');
const { safeFilename } = require('../utils/fsx');

const LETTERS = ['🅐', '🅑', '🅒', '🅓'];

function menu() {
    return kb([
        [btn('📄 Full transcript', 'st', 'tr'), btn('📝 Class notes', 'st', 'notes')],
        [btn('❓ Quiz me', 'st', 'quiz'), btn('🃏 Flashcards', 'st', 'fc')],
        [btn('🗓 Study plan', 'st', 'plan')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '📚 <b>Study</b>',
        txt.RULE,
        '',
        '<b>Transcript</b> — the whole spoken text, timestamped',
        '<b>Class notes</b> — structured revision notes with timings',
        '<b>Quiz</b> — 5 exam-style questions, answered right here',
        '<b>Flashcards</b> — tap to flip, swipe through the deck',
        '<b>Study plan</b> — a realistic daily pace for a course',
        '',
        '<i>Everything is built from the video transcript, so the video needs captions.</i>'
    ].join('\n');
}

function kitKeyboard(token) {
    return kb([
        [btn('📄 Transcript', 'st', 'tr2', token), btn('📝 Notes', 'st', 'notes2', token)],
        [btn('❓ Quiz', 'st', 'quiz2', token), btn('🃏 Flashcards', 'st', 'fc2', token)],
        [btn('🧠 Summarize', 'a', 'sum2', token), btn('💬 Chat', 'ch', 'load', token)],
        backRow('h', 'menu')
    ]);
}

function urlOf(token) {
    const entry = cache.get(token);
    return entry && entry.url ? entry.url : null;
}

// A stale session must never leave dead buttons on screen with no way out.
function expired(what) {
    return [
        `⌛ <b>That ${esc(what)} expired</b>`,
        '',
        'Sessions are held for an hour to keep memory low on the Pi.',
        '',
        'Start a fresh one below.'
    ].join('\n');
}

// --- Transcript ------------------------------------------------------------

async function runTranscript(ctx, url) {
    const p = await ui.Progress.open(ctx, 'Fetching the transcript');

    try {
        const data = await api.transcript(url);
        const lines = data.transcript || [];

        if (!lines.length) return p.finish('📄 <b>No transcript</b>\n\nThis video has no captions.', menu());

        const body = lines.map(l => `[${l.time}] ${l.text}`).join('\n');
        const preview = lines.slice(0, 30).map(l => `<code>${esc(l.time)}</code>  ${esc(l.text)}`).join('\n');

        await p.remove();

        await ui.send(ctx, [
            '📄 <b>Transcript</b>',
            txt.RULE,
            '',
            preview,
            '',
            `<i>${lines.length} lines · full text attached below.</i>`
        ].join('\n'), kb([]));

        return ui.sendTextFile(
            ctx,
            body,
            safeFilename('transcript.txt'),
            `📄 <b>${lines.length} lines</b>`,
            kb([backRow('st', 'menu')])
        );
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Notes -----------------------------------------------------------------

async function runNotes(ctx, url, refresh) {
    const p = await ui.Progress.open(ctx, 'Reading the lesson');

    try {
        await p.stage('Writing class notes', '<i>Structuring the transcript…</i>');
        const data = await api.aiNotes(url, refresh);
        const notes = data.notes || '';

        const token = cache.put({ url });
        const markup = kb([
            [btn('🔄 Rewrite', 'st', 'notesr', token)],
            [btn('❓ Quiz me on this', 'st', 'quiz2', token), btn('🃏 Flashcards', 'st', 'fc2', token)],
            backRow('st', 'menu')
        ]);

        const header = `📝 <b>Class notes</b>${data.cached ? ' <i>· cached</i>' : ''}\n${txt.RULE}\n\n`;
        const body = header + esc(notes);

        if (body.length <= 3800) return p.finish(body, markup);

        await p.remove();
        await ui.sendLong(ctx, body, markup);
        return ui.sendTextFile(ctx, notes, 'class-notes.md', '📝 <b>Notes as Markdown</b>', kb([]));
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Quiz ------------------------------------------------------------------

function quizQuestionText(state) {
    const q = state.questions[state.idx];
    const options = (q.options || []).slice(0, 4);

    return [
        `❓ <b>Question ${state.idx + 1} of ${state.questions.length}</b>`,
        `<code>${bar((state.idx) / state.questions.length, 10)}</code>  score ${state.score}`,
        txt.RULE,
        '',
        `<b>${esc(q.question)}</b>`,
        '',
        options.map((opt, i) => `${LETTERS[i]}  ${esc(opt)}`).join('\n')
    ].join('\n');
}

function quizQuestionKeyboard(token, state) {
    const q = state.questions[state.idx];
    const options = (q.options || []).slice(0, 4);

    return kb([
        ...options.map((opt, i) => [btn(`${LETTERS[i]}  ${truncate(opt, 28)}`, 'st', 'qa', token, i)]),
        [btn('🏳 Give up', 'st', 'qend', token)]
    ]);
}

function quizAnswerText(state, chosen) {
    const q = state.questions[state.idx];
    const correct = Number(q.answer) || 0;
    const right = chosen === correct;
    const options = (q.options || []).slice(0, 4);

    return [
        right ? '✅ <b>Correct</b>' : '❌ <b>Not quite</b>',
        txt.RULE,
        '',
        `<b>${esc(q.question)}</b>`,
        '',
        options.map((opt, i) => {
            const mark = i === correct ? '✅' : i === chosen ? '❌' : '▫️';
            return `${mark}  ${esc(opt)}`;
        }).join('\n'),
        '',
        q.explanation ? `💡 <i>${esc(q.explanation)}</i>` : '',
        '',
        `<b>Score</b> ${state.score} / ${state.idx + 1}`
    ].filter(Boolean).join('\n');
}

function quizResultText(state) {
    const total = state.questions.length;
    const ratio = total ? state.score / total : 0;
    const verdict = ratio === 1 ? 'Perfect run.'
        : ratio >= 0.8 ? 'Strong — you know this.'
            : ratio >= 0.5 ? 'Halfway there. Worth another pass.'
                : 'Go back over the notes and try again.';

    return [
        '🏁 <b>Quiz finished</b>',
        txt.RULE,
        '',
        `<code>${bar(ratio, 12)}</code>`,
        '',
        `<b>Score</b>  ${state.score} / ${total}`,
        '',
        `<i>${esc(verdict)}</i>`
    ].join('\n');
}

async function runQuiz(ctx, url, refresh) {
    const p = await ui.Progress.open(ctx, 'Reading the lesson');

    try {
        await p.stage('Writing questions', '<i>Building 5 exam-style questions…</i>');
        const data = await api.quiz(url, refresh);
        const questions = (data.questions || []).filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2);

        if (!questions.length) return p.finish('❓ <b>Could not build a quiz</b>\n\nThe transcript was too thin.', menu());

        const state = { url, questions, idx: 0, score: 0 };
        const token = cache.put(state);

        return p.finish(quizQuestionText(state), quizQuestionKeyboard(token, state));
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Flashcards ------------------------------------------------------------

function cardText(state) {
    const card = state.cards[state.idx];

    return [
        `🃏 <b>Card ${state.idx + 1} of ${state.cards.length}</b>`,
        `<code>${bar((state.idx + 1) / state.cards.length, 10)}</code>`,
        txt.RULE,
        '',
        `<b>${esc(card.front)}</b>`,
        '',
        state.flipped ? `${txt.RULE}\n\n${esc(card.back)}` : '<i>Tap Flip to reveal the answer.</i>'
    ].join('\n');
}

function cardKeyboard(token, state) {
    return kb([
        [btn(state.flipped ? '🔁 Hide answer' : '🔄 Flip', 'st', 'fcf', token)],
        [
            btn(state.idx > 0 ? '⬅️ Prev' : '·', 'st', 'fcn', token, 'p'),
            btn(`${state.idx + 1}/${state.cards.length}`, 'h', 'noop'),
            btn(state.idx < state.cards.length - 1 ? 'Next ➡️' : '·', 'st', 'fcn', token, 'n')
        ],
        backRow('st', 'menu')
    ]);
}

async function runFlashcards(ctx, url, refresh) {
    const p = await ui.Progress.open(ctx, 'Reading the lesson');

    try {
        await p.stage('Building the deck', '<i>Pulling out formulas and definitions…</i>');
        const data = await api.flashcards(url, refresh);
        const cards = (data.cards || []).filter(c => c && c.front && c.back);

        if (!cards.length) return p.finish('🃏 <b>Could not build a deck</b>\n\nThe transcript was too thin.', menu());

        const state = { url, cards, idx: 0, flipped: false };
        const token = cache.put(state);

        return p.finish(cardText(state), cardKeyboard(token, state));
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

// --- Plan ------------------------------------------------------------------

async function runPlan(ctx, goal, videoCount, totalDurationSec) {
    const p = await ui.Progress.open(ctx, 'Building a schedule');

    try {
        const plan = await api.plan(goal, videoCount, totalDurationSec);
        const days = Math.ceil(videoCount / Math.max(1, plan.videosPerDay || 1));

        const text = [
            '🗓 <b>Study plan</b>',
            txt.RULE,
            '',
            `<b>Goal</b>          ${esc(truncate(goal, 60))}`,
            `<b>Lessons</b>       ${videoCount}`,
            `<b>Total length</b>  ${hhmmss(totalDurationSec)}`,
            '',
            `<b>Pace</b>          ${plan.videosPerDay || 1} lesson(s) per day`,
            `<b>Finishes in</b>   ~${days} study day${days === 1 ? '' : 's'}`,
            `<b>Rest days</b>     ${(plan.restDays || []).length ? esc((plan.restDays || []).join(', ')) : 'none'}`,
            '',
            `<i>${esc(plan.message || '')}</i>`
        ].join('\n');

        return p.finish(text, kb([backRow('st', 'menu')]));
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

function register() {
    router.onMany({
        'st:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'st:menu2': async (ctx, [token]) => {
            await ui.ack(ctx);
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return ui.show(ctx, `📚 <b>Study kit</b>\n\n<code>${esc(truncate(url, 70))}</code>\n\nPick a tool.`, kitKeyboard(token));
        },

        'st:tr': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'transcript', back: ['st', 'menu'] });
        },

        'st:tr2': async (ctx, [token]) => {
            await ui.ack(ctx, '📄 Fetching…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runTranscript(ctx, url);
        },

        'st:notes': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'lesson', next: 'notes', back: ['st', 'menu'] });
        },

        'st:notes2': async (ctx, [token]) => {
            await ui.ack(ctx, '📝 Writing…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runNotes(ctx, url, false);
        },

        'st:notesr': async (ctx, [token]) => {
            await ui.ack(ctx, '🔄 Rewriting…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runNotes(ctx, url, true);
        },

        'st:quiz': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'lesson', next: 'quiz', back: ['st', 'menu'] });
        },

        'st:quiz2': async (ctx, [token]) => {
            await ui.ack(ctx, '❓ Building…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runQuiz(ctx, url, false);
        },

        'st:qa': async (ctx, [token, choice]) => {
            const state = cache.get(token);
            if (!state || !state.questions) {
                await ui.ack(ctx);
                return ui.show(ctx, expired('quiz'), menu());
            }

            const chosen = parseInt(choice, 10);
            const correct = Number(state.questions[state.idx].answer) || 0;
            const right = chosen === correct;

            if (right) state.score++;
            await ui.ack(ctx, right ? '✅ Correct' : '❌ Wrong');

            const last = state.idx >= state.questions.length - 1;
            const markup = kb([
                [btn(last ? '🏁 See result' : 'Next question ➡️', 'st', last ? 'qend' : 'qn', token)]
            ]);

            return ui.show(ctx, quizAnswerText(state, chosen), markup);
        },

        'st:qn': async (ctx, [token]) => {
            await ui.ack(ctx);

            const state = cache.get(token);
            if (!state || !state.questions) return ui.send(ctx, '⌛ That quiz expired.', menu());

            state.idx = Math.min(state.idx + 1, state.questions.length - 1);
            return ui.show(ctx, quizQuestionText(state), quizQuestionKeyboard(token, state));
        },

        'st:qend': async (ctx, [token]) => {
            await ui.ack(ctx);

            const state = cache.get(token);
            if (!state || !state.questions) return ui.send(ctx, '⌛ That quiz expired.', menu());

            const urlToken = cache.put({ url: state.url });

            return ui.show(ctx, quizResultText(state), kb([
                [btn('🔁 Retry this quiz', 'st', 'qr', token)],
                [btn('🆕 Fresh questions', 'st', 'qnew', urlToken)],
                [btn('🃏 Flashcards', 'st', 'fc2', urlToken)],
                backRow('st', 'menu')
            ]));
        },

        'st:qr': async (ctx, [token]) => {
            await ui.ack(ctx, '🔁 Restarting');

            const state = cache.get(token);
            if (!state || !state.questions) return ui.send(ctx, '⌛ That quiz expired.', menu());

            state.idx = 0;
            state.score = 0;
            return ui.show(ctx, quizQuestionText(state), quizQuestionKeyboard(token, state));
        },

        'st:qnew': async (ctx, [token]) => {
            await ui.ack(ctx, '🆕 Building…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runQuiz(ctx, url, true);
        },

        'st:fc': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'lesson', next: 'flashcards', back: ['st', 'menu'] });
        },

        'st:fc2': async (ctx, [token]) => {
            await ui.ack(ctx, '🃏 Building…');
            const url = urlOf(token);
            if (!url) return ui.send(ctx, '⌛ That link expired.', menu());
            return runFlashcards(ctx, url, false);
        },

        'st:fcf': async (ctx, [token]) => {
            const state = cache.get(token);
            if (!state || !state.cards) {
                await ui.ack(ctx);
                return ui.show(ctx, expired('deck'), menu());
            }

            state.flipped = !state.flipped;
            await ui.ack(ctx);
            return ui.show(ctx, cardText(state), cardKeyboard(token, state));
        },

        'st:fcn': async (ctx, [token, dir]) => {
            const state = cache.get(token);
            if (!state || !state.cards) {
                await ui.ack(ctx);
                return ui.show(ctx, expired('deck'), menu());
            }

            const next = dir === 'p' ? state.idx - 1 : state.idx + 1;
            if (next < 0 || next >= state.cards.length) return ui.ack(ctx);

            state.idx = next;
            state.flipped = false;
            await ui.ack(ctx);
            return ui.show(ctx, cardText(state), cardKeyboard(token, state));
        },

        'st:plan': async ctx => {
            await ui.ack(ctx);
            return flow.askText(ctx, {
                prompt: 'What is your goal?',
                hint: 'e.g. "finish this course before my exam in 3 weeks"',
                next: 'plan_goal',
                back: ['st', 'menu']
            });
        }
    });

    flow.onUrl('transcript', async (ctx, url) => runTranscript(ctx, url));
    flow.onUrl('notes', async (ctx, url) => runNotes(ctx, url, false));
    flow.onUrl('quiz', async (ctx, url) => runQuiz(ctx, url, false));
    flow.onUrl('flashcards', async (ctx, url) => runFlashcards(ctx, url, false));

    flow.onText('plan_goal', async (ctx, goal) => {
        return flow.askText(ctx, {
            prompt: 'How many lessons?',
            hint: 'Just the number of videos in the course.',
            next: 'plan_count',
            extra: { goal },
            back: ['st', 'menu']
        });
    });

    flow.onText('plan_count', async (ctx, value, { goal }) => {
        const count = parseInt(String(value).replace(/\D/g, ''), 10);

        if (!count || count < 1) {
            return flow.askText(ctx, {
                prompt: 'Send a number',
                hint: 'How many lessons are in the course?',
                next: 'plan_count',
                extra: { goal },
                back: ['st', 'menu']
            });
        }

        return flow.askText(ctx, {
            prompt: 'Total length in hours?',
            hint: 'Roughly is fine — e.g. 12',
            next: 'plan_hours',
            extra: { goal, count },
            back: ['st', 'menu']
        });
    });

    flow.onText('plan_hours', async (ctx, value, { goal, count }) => {
        const hours = parseFloat(String(value).replace(/[^\d.]/g, ''));
        const seconds = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3600) : count * 600;
        return runPlan(ctx, goal, count, seconds);
    });
}

module.exports = { register, menu, runPlan, kitKeyboard };
