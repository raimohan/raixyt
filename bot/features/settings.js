'use strict';

const router = require('../core/router');
const ui = require('../ui/render');
const txt = require('../ui/text');
const prefs = require('../services/prefs');
const { kb, btn, optionRow } = require('../ui/keyboards');
const { esc } = require('../utils/format');

const QUALITY = [
    { value: 'best', label: '⭐ Best' },
    { value: '1080p', label: '1080p' },
    { value: '720p', label: '720p' },
    { value: '480p', label: '480p' }
];

const SEND_AS = [
    { value: 'video', label: '🎬 Video' },
    { value: 'document', label: '📄 File' }
];

const SUMMARY = [
    { value: 'brief', label: 'Brief' },
    { value: 'detailed', label: 'Detailed' },
    { value: 'keypoints', label: 'Key points' },
    { value: 'chapters', label: 'Chapters' }
];

const SUB_FORMAT = [
    { value: 'srt', label: 'SRT' },
    { value: 'vtt', label: 'VTT' },
    { value: 'txt', label: 'TXT' }
];

const CLIP_QUALITY = [
    { value: '360', label: '360p' },
    { value: '480', label: '480p' },
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' }
];

const CLIP_RATIO = [
    { value: 'original', label: '🖥 Original' },
    { value: '9:16', label: '📱 9:16' },
    { value: '1:1', label: '⬜ 1:1' }
];

function settingsText(p) {
    return [
        '⚙️ <b>Settings</b>',
        txt.RULE,
        '',
        'Defaults used when you do not pick something explicitly.',
        '',
        `<b>Download quality</b>  ${esc(p.quality)}`,
        `<b>Send videos as</b>    ${esc(p.sendAs === 'video' ? 'playable video' : 'file')}`,
        `<b>Summary depth</b>     ${esc(p.summaryType)}`,
        `<b>Subtitle format</b>   ${esc(p.subFormat.toUpperCase())}`,
        `<b>Clip quality</b>      ${esc(p.clipQuality)}p`,
        `<b>Clip frame</b>        ${esc(p.clipRatio)}`,
        '',
        '<i>These are per-user and survive restarts.</i>'
    ].join('\n');
}

function settingsKeyboard(p) {
    return kb([
        [btn('— Download quality —', 'h', 'noop')],
        optionRow(QUALITY, p.quality, 'cf', 'set', 'quality'),

        [btn('— Send videos as —', 'h', 'noop')],
        optionRow(SEND_AS, p.sendAs, 'cf', 'set', 'sendAs'),

        [btn('— Summary depth —', 'h', 'noop')],
        optionRow(SUMMARY, p.summaryType, 'cf', 'set', 'summaryType'),

        [btn('— Subtitles / Clips —', 'h', 'noop')],
        optionRow(SUB_FORMAT, p.subFormat, 'cf', 'set', 'subFormat'),
        optionRow(CLIP_QUALITY, p.clipQuality, 'cf', 'set', 'clipQuality'),
        optionRow(CLIP_RATIO, p.clipRatio, 'cf', 'set', 'clipRatio'),

        [btn('♻️ Reset to defaults', 'cf', 'reset')],
        [btn('🏠 Home', 'h', 'menu')]
    ]);
}

function register() {
    router.onMany({
        'cf:menu': async ctx => {
            await ui.ack(ctx);
            const p = prefs.get(ctx.from.id);
            return ui.show(ctx, settingsText(p), settingsKeyboard(p));
        },

        'cf:set': async (ctx, [key, ...rest]) => {
            // "9:16" and "1:1" carry the separator, so the value arrives split.
            const value = rest.join(':');
            const updated = prefs.set(ctx.from.id, key, value);

            await ui.ack(ctx, '✅ Saved');
            return ui.show(ctx, settingsText(updated), settingsKeyboard(updated));
        },

        'cf:reset': async ctx => {
            const updated = prefs.reset(ctx.from.id);
            await ui.ack(ctx, '♻️ Reset');
            return ui.show(ctx, settingsText(updated), settingsKeyboard(updated));
        }
    });
}

module.exports = { register };
