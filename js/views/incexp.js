// ============================================================================
//  incexp.js — Income vs Expense for any period, grouped and sorted.
// ============================================================================
import { el, money, num, MONTHS, endOfMonth, downloadCSV, todayISO, fmtDate } from '../util.js';
import { DB } from '../store.js';
import * as C from '../calc.js';
import { groupedBars, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

let f = { year: String(new Date().getFullYear()), month: 'All', from: '', to: '', account: 'All' };
let groupBy = 'parent', sortBy = 'total';
let host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function period() {
  if (f.from || f.to) return { from: f.from || undefined, to: f.to || undefined };
  if (f.year === 'All') return {};
  const y = +f.year;
  if (f.month === 'All') return { from: `${y}-01-01`, to: `${y}-12-31` };
  return { from: `${y}-${String(f.month).padStart(2, '0')}-01`, to: endOfMonth(y, +f.month) };
}

function draw() {
  const S = SERIES();
  host.innerHTML = '';
  const p = period();
  const flt = { ...p, account: f.account };
  const res = C.incomeVsExpense(flt, groupBy);

  host.append(topbar('Income vs Expense',
    el('button', { class: 'btn sm', onclick: () => exportCSV(res) }, '⬇ CSV')));

  const sel = (label, key, opts, all) => {
    const s = el('select', {}, all ? el('option', { value: 'All' }, all) : null,
      ...opts.map(o => el('option', { value: o.v ?? o, selected: String(f[key]) === String(o.v ?? o) }, o.t ?? o)));
    s.onchange = () => { f[key] = s.value; f.from = f.to = ''; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  const dateIn = (label, key) => {
    const i = el('input', { type: 'date', value: f[key] || '' });
    i.onchange = () => { f[key] = i.value; f.year = 'All'; f.month = 'All'; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), i);
  };
  const segment = (opts, cur, on) => el('div', { class: 'seg' },
    opts.map(o => el('button', { class: cur === o.v ? 'on' : '', onclick: () => on(o.v) }, o.t)));

  host.append(el('div', { class: 'filters' },
    sel('Year', 'year', C.yearsPresent(), 'All years'),
    sel('Month', 'month', MONTHS.map((m, i) => ({ v: i + 1, t: m })), 'All months'),
    dateIn('From', 'from'), dateIn('To', 'to'),
    sel('Account', 'account', C.accountNames(), 'All accounts'),
    el('div', { class: 'field' }, el('label', {}, 'Group by'),
      segment([{ v: 'parent', t: 'Category' }, { v: 'sub', t: 'Sub' }, { v: 'account', t: 'Account' }], groupBy, v => { groupBy = v; draw(); })),
    el('div', { class: 'field' }, el('label', {}, 'Sort'),
      segment([{ v: 'total', t: 'Biggest' }, { v: 'name', t: 'A–Z' }], sortBy, v => { sortBy = v; draw(); }))));

  const periodLabel = p.from ? `${fmtDate(p.from)} → ${fmtDate(p.to || todayISO())}` : 'All periods';
  host.append(el('p', { class: 'small muted', style: 'margin:-4px 0 10px' }, '📅 ' + periodLabel));

  host.append(el('div', { class: 'grid g3' },
    kpi('▲ Total income (≈ INR)', money(res.income.equiv, 'INR', false), 'income'),
    kpi('▼ Total expense (≈ INR)', money(res.expense.equiv, 'INR', false), 'expense'),
    kpi('Net savings', money(res.net, 'INR', false), res.net >= 0 ? '' : 'expense')));

  const rows = sortBy === 'name'
    ? res.rows.slice().sort((a, b) => a.name.localeCompare(b.name))
    : res.rows;

  const chartCard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Top 12 — income vs expense side by side')));
  const ch = el('div', {}); chartCard.append(ch); host.append(chartCard);
  const top = res.rows.slice(0, 12);
  requestAnimationFrame(() => groupedBars(ch, {
    labels: top.map(r => r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name),
    series: [
      { name: '▲ Income', color: S.income, values: top.map(r => r.incSAR * C.rates().sar + r.incINR) },
      { name: '▼ Expense', color: S.expense, values: top.map(r => r.expSAR * C.rates().sar + r.expINR) },
    ],
  }));

  const t = el('table');
  t.append(el('thead', {}, el('tr', {},
    el('th', {}, groupBy === 'account' ? 'Account' : groupBy === 'sub' ? 'Sub-category' : 'Category'),
    el('th', { class: 'n' }, 'Income SAR'), el('th', { class: 'n' }, 'Income INR'),
    el('th', { class: 'n' }, 'Expense SAR'), el('th', { class: 'n' }, 'Expense INR'),
    el('th', { class: 'n' }, 'Total ≈ INR'))));
  const tb = el('tbody');
  for (const r of rows) {
    tb.append(el('tr', {}, el('td', {}, r.name),
      el('td', { class: 'n' }, r.incSAR ? num(r.incSAR) : '–'),
      el('td', { class: 'n' }, r.incINR ? num(r.incINR) : '–'),
      el('td', { class: 'n' }, r.expSAR ? num(r.expSAR) : '–'),
      el('td', { class: 'n' }, r.expINR ? num(r.expINR) : '–'),
      el('td', { class: 'n' }, num(r.equiv))));
  }
  t.append(tb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Breakdown')),
    el('div', { class: 'table-wrap', style: 'max-height:65vh;overflow:auto' }, t)));
}

function exportCSV(res) {
  const head = ['Group', 'Income SAR', 'Income INR', 'Expense SAR', 'Expense INR', 'Total ≈ INR'];
  downloadCSV(`jinnyfin-income-vs-expense-${todayISO()}.csv`,
    [head, ...res.rows.map(r => [r.name, r.incSAR, r.incINR, r.expSAR, r.expINR, r.equiv.toFixed(2)])]);
}
