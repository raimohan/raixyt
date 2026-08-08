'use strict';

const { kb, btn } = require('./keyboards');
const { esc, truncate } = require('../utils/format');

/**
 * The card shown when a link is pasted with no menu open — every module that
 * can act on a URL, one tap away.
 */
function keyboard(token) {
    return kb([
        [btn('⬇️ Download', 'd', 'an', token), btn('🎵 Extract MP3', 'd', 'mp3', token)],
        [btn('⚡ Quick grab (my default quality)', 'd', 'quick', token)],
        [btn('🧠 Summarize', 'a', 'sum2', token), btn('✂️ Clip it', 'c', 'load', token)],
        [btn('📝 Subtitles', 's', 'load', token), btn('📄 Transcript', 'st', 'tr2', token)],
        [btn('📚 Study kit', 'st', 'menu2', token), btn('💬 Chat about it', 'ch', 'load', token)],
        [btn('📊 Metadata', 'an', 'meta2', token), btn('🖼 Thumbnails', 'an', 'thumb2', token)],
        [btn('🔥 Viral moment', 'a', 'viral2', token)],
        [btn('🏠 Home', 'h', 'menu')]
    ]);
}

function card(url) {
    return [
        '🔗 <b>Link detected</b>',
        '',
        `<code>${esc(truncate(url, 80))}</code>`,
        '',
        'What should I do with it?'
    ].join('\n');
}

module.exports = { keyboard, card };
