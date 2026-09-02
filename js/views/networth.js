// ============================================================================
//  networth.js — the full net-worth build-up plus fixed assets at market value.
// ============================================================================
import { el, money, num, fmtDate, todayISO, modal, toast, confirmBox, downloadCSV, MON3 } from '../util.js';
import { DB, put, remove } from '../store.js';
import * as C from '../calc.js';
import { lineChart, barList, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

let asOf = '', host = null, showAll = false;

export async function render(root) { host = root; asOf = asOf || todayISO(); draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  const S = SERIES();
  host.innerHTML = '';
  const nw = C.netWorth(asOf);
  const fa = nw.parts.fa, inv = nw.parts.inv, lb = nw.parts.lb;

  const dateIn = el('input', { type: 'date', value: asOf, onchange: e => { asOf = e.target.value; draw(); } });
  host.append(topbar('Net Worth & Assets',
    el('div', { class: 'field' }, el('label', { class: 'hint' }, 'As of'), dateIn),
    el('button', { class: 'btn sm', onclick: () => addAsset() }, '+ Asset'),
    el('button', { class: 'btn sm', onclick: exportCSV }, '⬇ CSV')));

  host.append(el('div', { class: 'card', style: 'margin-bottom:12px' },
    el('div', { class: 'stat' },
      el('div', { class: 'label' }, '🏦 Net worth as of ' + fmtDate(asOf)),
      el('div', { class: 'value tnum', style: 'font-size:clamp(26px,6vw,42px)' }, money(nw.total, 'INR', false)),
      el('div', { class: 'sub' }, 'cash + investments + assets − what you owe'))));

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('💵 Cash & bank', money(nw.cash, 'INR', false)),
    kpi('📈 Investments', money(nw.investments, 'INR', false)),
    kpi('🏡 Fixed assets', money(nw.assets, 'INR', false)),
    kpi('🤝 Lend / borrow', money(nw.lendBorrow, 'INR', false), nw.lendBorrow < 0 ? 'expense' : 'income')));

  // ----------------------------------------------------------- the trend --
  const trendCard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Month-end net worth'), el('div', { class: 'spacer' }),
      el('label', { class: 'chip', style: 'cursor:pointer' },
        el('input', { type: 'checkbox', checked: showAll, onchange: e => { showAll = e.target.checked; draw(); } }), ' since 2017')));
  const th = el('div', {}); trendCard.append(th); host.append(trendCard);
  requestAnimationFrame(() => {
    let series = C.netWorthSeries(showAll ? null : new Date().getFullYear() - 2);
    lineChart(th, {
      labels: series.map(s => MON3[+s.month.slice(5, 7) - 1] + ' ' + s.month.slice(2, 4)),
      values: series.map(s => s.total), color: S.s1,
    });
  });

  // ------------------------------------------------------------ build-up --
  const parts = [
    { label: '💵 Cash & bank', value: nw.cash, color: S.s1 },
    { label: '📈 Investments', value: nw.investments, color: S.s3 },
    { label: '🏡 Fixed assets', value: nw.assets, color: S.s2 },
    { label: '🤝 Owed (net)', value: Math.abs(nw.lendBorrow), color: S.s8 },
  ];
  const bcard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'What it is made of')));
  const bh = el('div', {}); bcard.append(bh);
  barList(bh, parts, { format: v => money(v, 'INR', false) });
  bcard.append(el('p', { class: 'hint', style: 'margin-top:8px' }, 'The "owed" bar is subtracted, not added.'));
  host.append(bcard);

  // -------------------------------------------------------- fixed assets --
  const at = el('table');
  at.append(el('thead', {}, el('tr', {}, el('th', {}, 'Asset'), el('th', {}, 'Fed by category'),
    el('th', { class: 'n' }, 'Cost'), el('th', { class: 'n' }, 'Market value'),
    el('th', { class: 'n' }, 'Gain / loss'), el('th', { class: 'n' }, 'Gain %'), el('th', { class: 'n' }, 'Value used'))));
  const atb = el('tbody');
  for (const a of fa.rows) {
    atb.append(el('tr', { style: 'cursor:pointer', onclick: () => addAsset(a) },
      el('td', {}, a.name), el('td', { class: 'muted small' }, a.category_tag || '—'),
      el('td', { class: 'n' }, num(a.cost, 0)),
      el('td', { class: 'n' }, a.market ? num(a.market, 0) : el('span', { class: 'muted' }, 'not set')),
      el('td', { class: 'n ' + (a.gain >= 0 ? 'pos' : 'neg') }, a.market ? num(a.gain, 0) : '–'),
      el('td', { class: 'n ' + (a.gain >= 0 ? 'pos' : 'neg') }, a.market ? (a.gainPct * 100).toFixed(1) + '%' : '–'),
      el('td', { class: 'n' }, num(a.used, 0))));
  }
  atb.append(el('tr', { class: 'total' }, el('td', {}, 'TOTAL'), el('td', {}),
    el('td', { class: 'n' }, num(fa.rows.reduce((s, a) => s + a.cost, 0), 0)),
    el('td', { class: 'n' }, num(fa.rows.reduce((s, a) => s + a.market, 0), 0)),
    el('td', { class: 'n' }, num(fa.rows.reduce((s, a) => s + a.gain, 0), 0)), el('td', {}),
    el('td', { class: 'n' }, num(fa.total, 0))));
  at.append(atb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Fixed assets'), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, 'cost is built up from your tagged spending; set a market value to override it')),
    el('div', { class: 'table-wrap' }, at)));

  // -------------------------------------------------------- investments ---
  const it = el('table');
  it.append(el('thead', {}, el('tr', {}, el('th', {}, 'Holding'), el('th', {}, 'Tracked as'),
    el('th', { class: 'n' }, 'Deposits'), el('th', { class: 'n' }, 'Returns'), el('th', { class: 'n' }, 'Value ≈ INR'))));
  const itb = el('tbody');
  for (const d of inv.detail) {
    itb.append(el('tr', {}, el('td', {}, d.name), el('td', { class: 'muted small' }, d.kind),
      el('td', { class: 'n' }, d.deposits != null ? num(d.deposits, 0) : '–'),
      el('td', { class: 'n' }, d.interest != null ? num(d.interest, 0) : '–'),
      el('td', { class: 'n' }, num(d.value, 0))));
  }
  itb.append(el('tr', { class: 'total' }, el('td', {}, 'TOTAL'), el('td', {}), el('td', {}), el('td', {}),
    el('td', { class: 'n' }, num(inv.total, 0))));
  it.append(itb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Investments & savings')),
    el('div', { class: 'table-wrap' }, it)));

  host.append(el('p', { class: 'small muted', style: 'margin-top:10px' },
    `Open lend/borrow positions: ${lb.openCount}. `,
    el('a', { href: '#/payee' }, 'See who owes whom →')));
}

function addAsset(a = null) {
  const v = a || { name: '', category_tag: '', opening_cost: 0, market_value: 0, market_date: todayISO(), note: '' };
  const name = el('input', { value: v.name, placeholder: 'Land @ Edamulakkal' });
  const tag = el('input', { value: v.category_tag || '', list: 'dl-cat', placeholder: 'Expense category that feeds it' });
  const open = el('input', { type: 'number', step: 'any', value: v.opening_cost || 0 });
  const mv = el('input', { type: 'number', step: 'any', value: v.market_value || 0 });
  const md = el('input', { type: 'date', value: v.market_date || todayISO() });
  const note = el('input', { value: v.note || '' });
  const dl = el('datalist', { id: 'dl-cat' }); C.parentsFor('Expense').forEach(p => dl.append(el('option', { value: p })));
  const fld = (l, n, cls = '', hint) => el('div', { class: 'field ' + cls }, el('label', {}, l), n, hint ? el('span', { class: 'hint' }, hint) : null);
  const body = el('div', { class: 'form-grid' },
    fld('Asset name', name, 'full'),
    fld('Fed by category', tag, 'full', 'Every expense in this category adds to the asset cost.'),
    fld('Pre-ledger cost', open, '', 'What you had already paid before this ledger started.'),
    fld('Market value today', mv, '', 'Leave 0 to keep valuing it at cost.'),
    fld('Valued on', md), fld('Note', note), dl);
  const m = modal(a ? 'Edit asset' : 'New asset', body, {
    footer: [
      a ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this asset?')) { await remove('assets', a.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return toast('Name?', 'warn');
        await put('assets', { ...v, name: name.value.trim(), category_tag: tag.value.trim() || null,
          opening_cost: +open.value || 0, market_value: +mv.value || 0, market_date: md.value, note: note.value.trim() });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}

function exportCSV() {
  const series = C.netWorthSeries(null);
  downloadCSV(`jinnyfin-networth-${todayISO()}.csv`,
    [['Month end', 'Cash & bank', 'Investments', 'Fixed assets', 'Lend/borrow', 'Net worth'],
      ...series.map(s => [s.month, s.cash.toFixed(2), s.investments.toFixed(2), s.assets.toFixed(2), s.lendBorrow.toFixed(2), s.total.toFixed(2)])]);
}
