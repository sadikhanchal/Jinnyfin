// ============================================================================
//  budgets.js — a monthly ceiling per category, with how much is left.
//  (Not in the workbook — the "additional enthelum" part.)
// ============================================================================
import { el, money, num, MONTHS, modal, toast, confirmBox } from '../util.js';
import { DB, put, remove } from '../store.js';
import * as C from '../calc.js';
import { SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

const now = new Date();
let year = String(now.getFullYear()), month = String(now.getMonth() + 1), host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  const S = SERIES();
  host.innerHTML = '';
  host.append(topbar('Budgets', el('button', { class: 'btn sm primary', onclick: () => edit() }, '+ Budget')));

  const ySel = el('select', {}, ...C.yearsPresent().map(y => el('option', { value: y, selected: year == y }, y)));
  const mSel = el('select', {}, ...MONTHS.map((m, i) => el('option', { value: i + 1, selected: month == i + 1 }, m)));
  ySel.onchange = () => { year = ySel.value; draw(); };
  mSel.onchange = () => { month = mSel.value; draw(); };
  host.append(el('div', { class: 'filters' },
    el('div', { class: 'field' }, el('label', {}, 'Year'), ySel),
    el('div', { class: 'field' }, el('label', {}, 'Month'), mSel)));

  const rows = C.budgetStatus(year, month);
  if (!rows.length) {
    host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🎯'),
      el('p', {}, 'No budgets yet. Set a monthly ceiling on the categories that run away from you.'),
      el('button', { class: 'btn primary', onclick: () => edit() }, 'Set the first budget')));
    return;
  }
  const spent = rows.reduce((s, r) => s + r.spent, 0), limit = rows.reduce((s, r) => s + r.limit, 0);
  host.append(el('div', { class: 'grid g3' },
    kpi('Budgeted', money(limit, 'INR', false)),
    kpi('Spent', money(spent, 'INR', false), spent > limit ? 'expense' : ''),
    kpi('Left', money(limit - spent, 'INR', false), limit - spent < 0 ? 'expense' : 'income')));

  const list = el('div', { class: 'grid', style: 'margin-top:12px' });
  for (const r of rows) {
    const pct = Math.min(150, r.pct * 100);
    const col = r.pct > 1 ? 'var(--critical)' : r.pct > 0.85 ? 'var(--warning)' : S.income;
    // A riyal budget is read in riyals — that is the number he set. The rupee
    // figure follows underneath, because the spending itself is in both.
    const sar = r.currency === 'SAR';
    const headline = sar
      ? `${money(r.spentOwn, 'SAR', false)} / ${money(r.limitOwn, 'SAR', false)}`
      : `${money(r.spent, 'INR', false)} / ${money(r.limit, 'INR', false)}`;
    const leftLine = sar
      ? (r.leftOwn >= 0 ? `${money(r.leftOwn, 'SAR', false)} left` : `over by ${money(-r.leftOwn, 'SAR', false)}`)
      : (r.left >= 0 ? `${money(r.left, 'INR', false)} left` : `over by ${money(-r.left, 'INR', false)}`);
    list.append(el('div', { class: 'card tight', style: 'cursor:pointer', onclick: () => edit(r) },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('b', {}, r.parent + (r.sub ? ' · ' + r.sub : '')),
        el('span', { class: 'tnum small' }, headline)),
      el('div', { class: 'bar-track', style: 'margin:7px 0 4px' },
        el('div', { class: 'bar-fill', style: `width:${Math.min(100, pct)}%;background:${col}` })),
      el('div', { class: 'small muted' },
        `${leftLine} · ${(r.pct * 100).toFixed(0)}% used`,
        sar ? ` · ≈ ${money(r.spent, 'INR', false)} / ${money(r.limit, 'INR', false)}` : '')));
  }
  host.append(list);
}

function edit(b = null) {
  const v = b || { parent: '', sub: '', amount: 0, currency: 'INR', period: 'monthly' };
  // A budget can only mean something if it points at a category that exists.
  // These were free-text boxes with a suggestion list, and a suggestion list is
  // only ever a suggestion — "adasdasdas" was accepted and then matched nothing,
  // so the budget silently watched no spending at all. Both are lists now.
  const cats = C.parentsFor('Expense');
  const parent = el('select', {},
    el('option', { value: '' }, '— pick a category —'),
    // keep a category that has since been renamed away, so editing an old
    // budget cannot quietly repoint it at something else
    ...(v.parent && !cats.includes(v.parent) ? [v.parent] : []).concat(cats)
      .map(p => el('option', { value: p, selected: v.parent === p }, p)));
  const sub = el('select', {});
  const fillSubs = () => {
    const list = parent.value ? C.subsFor('Expense', parent.value) : [];
    sub.replaceChildren(el('option', { value: '' }, 'All sub-categories'),
      ...list.map(s => el('option', { value: s, selected: v.sub === s }, s)));
    if (v.sub && !list.includes(v.sub)) sub.append(el('option', { value: v.sub, selected: true }, v.sub));
  };
  fillSubs();
  parent.onchange = () => { v.sub = ''; fillSubs(); };
  const amount = el('input', { type: 'number', step: 'any', value: v.amount || '' });
  const cur = el('select', {}, ...['INR', 'SAR'].map(c => el('option', { value: c, selected: v.currency === c }, c)));
  const period = el('select', {}, el('option', { value: 'monthly', selected: v.period !== 'yearly' }, 'Per month'),
    el('option', { value: 'yearly', selected: v.period === 'yearly' }, 'Per year'));
  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const body = el('div', { class: 'form-grid' },
    fld('Category', parent, 'full'), fld('Sub-category', sub, 'full'),
    fld('Amount', amount), fld('Currency', cur), fld('Period', period, 'full'));
  const m = modal(b ? 'Edit budget' : 'New budget', body, {
    footer: [
      b ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this budget?')) { await remove('budgets', b.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!parent.value) return toast('Pick a category', 'warn');
        await put('budgets', { ...v, parent: parent.value, sub: sub.value || null,
          amount: +amount.value || 0, currency: cur.value, period: period.value });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}
