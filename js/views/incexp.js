// ============================================================================
//  incexp.js — Income vs Expense for any period, grouped and sorted.
// ============================================================================
import { el, money, num, MONTHS, endOfMonth, downloadCSV, todayISO, fmtDate,
  dateGuard, dateBox, searchSelect } from '../util.js';
import { DB } from '../store.js';
import * as C from '../calc.js';
import { groupedBars, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

let f = { year: String(new Date().getFullYear()), month: 'All', from: '', to: '', account: 'All' };
let groupBy = 'parent', sortBy = 'total';
let host = null;
let ctl = null;          // the filter bar — built once per visit, never rebuilt under the cursor
let body = null;         // everything below it, redrawn on every change
let res = null;          // what is on screen, for the CSV button

export async function render(root) { host = root; mount(); }
export function refresh() { if (host && body?.isConnected) draw(); }

function period() {
  if (f.from || f.to) return { from: f.from || undefined, to: f.to || undefined };
  if (f.year === 'All') return {};
  const y = +f.year;
  if (f.month === 'All') return { from: `${y}-01-01`, to: `${y}-12-31` };
  return { from: `${y}-${String(f.month).padStart(2, '0')}-01`, to: endOfMonth(y, +f.month) };
}

/**
 * The bar is built once, like Transactions and the two Reports. Rebuilding it
 * on every change threw away the Account search box in the middle of a Tab,
 * and the date boxes in the middle of being typed into.
 */
function mount() {
  host.innerHTML = '';
  ctl = buildControls();
  body = el('div', {});
  host.append(topbar('Income vs Expense',
    el('button', { class: 'btn sm', onclick: () => res && exportCSV(res) }, '⬇ CSV')), ctl.bar, body);
  draw();
}

function buildControls() {
  const plain = (key, opts, all) => {
    const s = el('select', { 'data-fk': key }, el('option', { value: 'All' }, all),
      ...opts.map(o => el('option', { value: o.v ?? o }, o.t ?? o)));
    s.addEventListener('change', () => { f[key] = s.value; f.from = f.to = ''; draw(); });
    return s;
  };
  const year = plain('year', C.yearsPresent(), 'All years');
  const month = plain('month', MONTHS.map((m, i) => ({ v: i + 1, t: m })), 'All months');
  const dateIn = key => dateGuard(dateBox({ value: f[key] || '' }), v => {
    if (v === (f[key] || '')) return;
    f[key] = v; f.year = 'All'; f.month = 'All'; draw();
  }, key);
  const from = dateIn('from'), to = dateIn('to');
  // Accounts run long; the same search box as everywhere else (see searchSelect).
  const account = searchSelect([], { placeholder: 'All accounts' });
  account.dataset.fk = 'account';
  // Picking an account narrows the period already set — it used to share the
  // Year box's handler and quietly wipe a From–To range along with it.
  account.addEventListener('change', () => { f.account = account.value; draw(); });
  const segment = (opts, get, set) => {
    const wrap = el('div', { class: 'seg' });
    const paint = () => [...wrap.children].forEach(b => b.classList.toggle('on', b.dataset.v === get()));
    wrap.append(...opts.map(o => el('button', { dataset: { v: o.v }, onclick: () => { set(o.v); paint(); draw(); } }, o.t)));
    paint();
    return wrap;
  };
  const field = (label, node) => el('div', { class: 'field' }, el('label', {}, label), node);
  const bar = el('div', { class: 'filters' },
    field('Year', year), field('Month', month), field('From', from), field('To', to),
    field('Account', account),
    field('Group by', segment([{ v: 'parent', t: 'Category' }, { v: 'sub', t: 'Sub' }, { v: 'account', t: 'Account' }],
      () => groupBy, v => { groupBy = v; })),
    field('Sort', segment([{ v: 'total', t: 'Biggest' }, { v: 'name', t: 'A–Z' }], () => sortBy, v => { sortBy = v; })));
  return { bar, year, month, from, to, account };
}

/** Keep every control saying what the filters are — a Year pick empties the dates, and so on. */
function syncControls() {
  const { year, month, from, to, account } = ctl;
  for (const [s, v] of [[year, f.year], [month, f.month]]) {
    if (document.activeElement === s && s.value === String(v)) continue;
    s.value = String(v);
    if (s.selectedIndex < 0) s.selectedIndex = 0;
  }
  for (const [d, v] of [[from, f.from], [to, f.to]]) {
    if (document.activeElement !== d && d.value !== (v || '')) d.setGuarded(v);
  }
  const names = C.accountNames();
  const list = [{ value: 'All', search: 'All accounts', label: 'All accounts' },
    ...names.map(a => ({ value: a, search: a, label: a }))];
  if (f.account !== 'All' && !names.includes(f.account)) list.push({ value: f.account, search: f.account, label: f.account });
  account.setOptions(list);
  account.value = f.account;
}

function draw() {
  if (!body) return;
  syncControls();
  const S = SERIES();
  body.innerHTML = '';
  const host = body;                 // everything below the bar lands in the body
  const p = period();
  const flt = { ...p, account: f.account };
  res = C.incomeVsExpense(flt, groupBy);

  const periodLabel = p.from ? `${fmtDate(p.from)} → ${fmtDate(p.to || todayISO())}` : 'All periods';
  host.append(el('p', { class: 'small muted', style: 'margin:-4px 0 10px' }, periodLabel));

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
      // The dash is an absence, not an amount — it stays grey.
      el('td', { class: r.incSAR ? 'n in' : 'n muted' }, r.incSAR ? num(r.incSAR) : '–'),
      el('td', { class: r.incINR ? 'n in' : 'n muted' }, r.incINR ? num(r.incINR) : '–'),
      el('td', { class: r.expSAR ? 'n out' : 'n muted' }, r.expSAR ? num(r.expSAR) : '–'),
      el('td', { class: r.expINR ? 'n out' : 'n muted' }, r.expINR ? num(r.expINR) : '–'),
      el('td', { class: 'n ' + (r.equiv < 0 ? 'neg' : '') }, num(r.equiv))));
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
