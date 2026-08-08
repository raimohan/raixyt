'use strict';

const { Markup } = require('telegraf');
const log = require('../utils/logger').tag('kb');

const MAX_CB = 64;

function cb(...parts) {
    const data = parts.filter(p => p !== undefined && p !== null).join(':');
    if (Buffer.byteLength(data) > MAX_CB) {
        log.warn(`callback_data too long (${data.length}): ${data}`);
        return data.slice(0, MAX_CB);
    }
    return data;
}

const btn = (text, ...data) => Markup.button.callback(text, cb(...data));
const url = (text, link) => Markup.button.url(text, link);
const kb = rows => Markup.inlineKeyboard(rows.filter(Boolean));

// Lay a flat list of buttons out n-per-row.
function grid(buttons, perRow = 2) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += perRow) {
        rows.push(buttons.slice(i, i + perRow));
    }
    return rows;
}

const backRow = (...data) => [btn('◀️ Back', ...data), btn('🏠 Home', 'h', 'menu')];
const homeRow = () => [btn('🏠 Home', 'h', 'menu')];
const closeRow = () => [btn('✖️ Close', 'h', 'close')];

/**
 * Pager for any list feature: renders page items via `render(item, index)` and
 * appends a "‹ 2/7 ›" strip that only shows when there is more than one page.
 */
function paginated({ items, page, perPage, render, navPrefix, extraRows = [], backTo }) {
    const total = Math.max(1, Math.ceil(items.length / perPage));
    const current = Math.min(Math.max(0, page), total - 1);
    const slice = items.slice(current * perPage, current * perPage + perPage);

    const rows = slice.map((item, i) => {
        const built = render(item, current * perPage + i);
        return Array.isArray(built) ? built : [built];
    });

    if (total > 1) {
        rows.push([
            btn(current > 0 ? '⬅️' : '·', ...navPrefix, Math.max(0, current - 1)),
            btn(`${current + 1} / ${total}`, 'h', 'noop'),
            btn(current < total - 1 ? '➡️' : '·', ...navPrefix, Math.min(total - 1, current + 1))
        ]);
    }

    for (const row of extraRows) rows.push(row);
    rows.push(backTo ? backRow(...backTo) : homeRow());

    return { markup: kb(rows), page: current, pages: total, slice };
}

// A row of mutually exclusive options with a ✅ on the active one.
function optionRow(options, activeValue, ...prefix) {
    return options.map(opt =>
        btn(`${opt.value === activeValue ? '✅ ' : ''}${opt.label}`, ...prefix, opt.value)
    );
}

module.exports = { cb, btn, url, kb, grid, backRow, homeRow, closeRow, paginated, optionRow, MAX_CB };
