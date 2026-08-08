'use strict';

const router = require('../core/router');
const flow = require('../core/flow');
const cache = require('../core/cache');
const session = require('../core/session');
const ui = require('../ui/render');
const txt = require('../ui/text');
const { api } = require('../api/client');
const { kb, btn, backRow } = require('../ui/keyboards');
const { esc, truncate, hidden, hhmmss, num } = require('../utils/format');

const MAX_TURNS = 16;

const SUGGESTIONS = [
    { key: 's1', label: '📌 Key takeaways', prompt: 'Give me the key takeaways from this video as a short list.' },
    { key: 's2', label: '🧒 Explain simply', prompt: 'Explain what this video covers in simple language, as if to a beginner.' },
    { key: 's3', label: '💡 Content ideas', prompt: 'Give me 3 content ideas inspired by this video.' },
    { key: 's4', label: '🕘 Rough outline', prompt: 'Break this video into a rough section-by-section outline.' }
];

function menu() {
    return kb([
        [btn('💬 Start a chat', 'ch', 'start')],
        [btn('◀️ Back', 'h', 'menu')]
    ]);
}

function menuText() {
    return [
        '💬 <b>Video Chat</b>',
        txt.RULE,
        '',
        'Load a video, then just type. I answer using its title, channel, description and metadata.',
        '',
        'Ask for takeaways, an explanation, a script, timestamps, a translation — anything.',
        '',
        '<i>The conversation stays open until you tap End chat.</i>'
    ].join('\n');
}

function chatKeyboard() {
    return kb([
        [btn(SUGGESTIONS[0].label, 'ch', 'sug', SUGGESTIONS[0].key), btn(SUGGESTIONS[1].label, 'ch', 'sug', SUGGESTIONS[1].key)],
        [btn(SUGGESTIONS[2].label, 'ch', 'sug', SUGGESTIONS[2].key), btn(SUGGESTIONS[3].label, 'ch', 'sug', SUGGESTIONS[3].key)],
        [btn('🧹 Clear history', 'ch', 'clear'), btn('🚪 End chat', 'ch', 'end')]
    ]);
}

function openingText(info) {
    return [
        `${info.thumbnail ? hidden(info.thumbnail) : ''}💬 <b>${esc(truncate(info.title, 80))}</b>`,
        '',
        `👤 ${esc(info.channel || info.uploader || '—')}`,
        `⏱ ${hhmmss(info.duration)}${info.view_count ? ` · 👁 ${esc(num(info.view_count))}` : ''}`,
        '',
        txt.RULE,
        '',
        '<b>Chat is open.</b> Type anything about this video and I will answer.',
        '',
        '<i>Or tap one of the starters below.</i>'
    ].join('\n');
}

async function startChat(ctx, url) {
    const p = await ui.Progress.open(ctx, 'Loading the video');

    try {
        const info = await api.chatInfo(url);

        const state = session.get(ctx.from.id);
        state.chat = {
            url,
            videoId: url,
            videoData: {
                title: info.title,
                channel: info.channel || info.uploader,
                duration: hhmmss(info.duration),
                description: info.description || ''
            },
            thumbnail: info.thumbnail || '',
            messages: []
        };

        session.setAwait(ctx.from.id, 'chat_msg', {}, { keep: true });

        return p.finish(openingText(info), chatKeyboard(), { preview: !!info.thumbnail });
    } catch (err) {
        return p.fail(router.explain(err), menu());
    }
}

async function ask(ctx, question) {
    const state = session.get(ctx.from.id);

    if (!state.chat) {
        return ui.send(ctx, '💬 <b>No chat open</b>\n\nLoad a video first.', menu());
    }

    state.chat.messages.push({ role: 'user', content: question });
    if (state.chat.messages.length > MAX_TURNS) {
        state.chat.messages = state.chat.messages.slice(-MAX_TURNS);
    }

    await ui.typing(ctx);
    const p = await ui.Progress.open(ctx, 'Thinking');

    try {
        const data = await api.chat(state.chat.videoId, state.chat.videoData, state.chat.messages);
        const answer = data.response || '';

        state.chat.messages.push({ role: 'assistant', content: answer });
        session.setAwait(ctx.from.id, 'chat_msg', {}, { keep: true });

        const body = `💬 ${esc(answer)}`;

        if (body.length <= 3800) return p.finish(body, chatKeyboard());

        await p.remove();
        return ui.sendLong(ctx, body, chatKeyboard());
    } catch (err) {
        state.chat.messages.pop();
        session.setAwait(ctx.from.id, 'chat_msg', {}, { keep: true });
        return p.fail(router.explain(err), chatKeyboard());
    }
}

function register() {
    router.onMany({
        'ch:menu': async ctx => {
            await ui.ack(ctx);
            return ui.show(ctx, menuText(), menu());
        },

        'ch:start': async ctx => {
            await ui.ack(ctx);
            return flow.askUrl(ctx, { what: 'video', next: 'chat', back: ['ch', 'menu'] });
        },

        'ch:load': async (ctx, [token]) => {
            await ui.ack(ctx, '💬 Loading…');
            const entry = cache.get(token);
            if (!entry || !entry.url) return ui.send(ctx, '⌛ That link expired.', menu());
            return startChat(ctx, entry.url);
        },

        'ch:sug': async (ctx, [key]) => {
            await ui.ack(ctx, '💬 Asking…');
            const suggestion = SUGGESTIONS.find(s => s.key === key);
            if (!suggestion) return;
            return ask(ctx, suggestion.prompt);
        },

        'ch:clear': async ctx => {
            const state = session.get(ctx.from.id);
            if (state.chat) state.chat.messages = [];
            await ui.ack(ctx, '🧹 History cleared');
            return ui.show(ctx, '🧹 <b>History cleared</b>\n\nThe video is still loaded — keep typing.', chatKeyboard());
        },

        'ch:end': async ctx => {
            const state = session.get(ctx.from.id);
            state.chat = null;
            session.clearAwait(ctx.from.id);

            await ui.ack(ctx, '🚪 Chat closed');
            return ui.show(ctx, '🚪 <b>Chat closed</b>\n\nLoad another video whenever you like.', menu());
        }
    });

    flow.onUrl('chat', async (ctx, url) => startChat(ctx, url));

    router.onInput('chat_msg', async (ctx, text) => ask(ctx, text));
}

module.exports = { register, menu, startChat };
