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
    list.append(el('div', { class: 'card tight', style: 'cursor:pointer', onclick: () => edit(r) },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('b', {}, r.parent + (r.sub ? ' · ' + r.sub : '')),
        el('span', { class: 'tnum small' }, `${money(r.spent, 'INR', false)} / ${money(r.limit, 'INR', false)}`)),
      el('div', { class: 'bar-track', style: 'margin:7px 0 4px' },
        el('div', { class: 'bar-fill', style: `width:${Math.min(100, pct)}%;background:${col}` })),
      el('div', { class: 'small muted' },
        r.left >= 0 ? `${money(r.left, 'INR', false)} left · ${(r.pct * 100).toFixed(0)}% used`
          : `over by ${money(-r.left, 'INR', false)}`)));
  }
  host.append(list);
}

function edit(b = null) {
  const v = b || { parent: '', sub: '', amount: 0, currency: 'INR', period: 'monthly' };
  const parent = el('input', { value: v.parent, list: 'dl-bp', placeholder: 'Food and Dining' });
  const sub = el('input', { value: v.sub || '', placeholder: 'optional' });
  const amount = el('input', { type: 'number', step: 'any', value: v.amount || '' });
  const cur = el('select', {}, ...['INR', 'SAR'].map(c => el('option', { value: c, selected: v.currency === c }, c)));
  const period = el('select', {}, el('option', { value: 'monthly', selected: v.period !== 'yearly' }, 'Per month'),
    el('option', { value: 'yearly', selected: v.period === 'yearly' }, 'Per year'));
  const dl = el('datalist', { id: 'dl-bp' }); C.parentsFor('Expense').forEach(p => dl.append(el('option', { value: p })));
  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const body = el('div', { class: 'form-grid' },
    fld('Category', parent, 'full'), fld('Sub-category', sub, 'full'),
    fld('Amount', amount), fld('Currency', cur), fld('Period', period, 'full'), dl);
  const m = modal(b ? 'Edit budget' : 'New budget', body, {
    footer: [
      b ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this budget?')) { await remove('budgets', b.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!parent.value.trim()) return toast('Pick a category', 'warn');
        await put('budgets', { ...v, parent: parent.value.trim(), sub: sub.value.trim() || null,
          amount: +amount.value || 0, currency: cur.value, period: period.value });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}
