// ============================================================================
//  budgets.js — a monthly ceiling per category, with how much is left.
//  (Not in the workbook — the "additional enthelum" part.)
// ============================================================================
import { el, money, num, MONTHS, modal, toast, confirmBox,
  onFilter, restoreFilterFocus } from '../util.js';
import { DB, put, remove } from '../store.js';
import * as C from '../calc.js';
import { SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';
import { icon } from '../icons.js';

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
  onFilter(ySel, 'year', () => { year = ySel.value; draw(); });
  onFilter(mSel, 'month', () => { month = mSel.value; draw(); });
  host.append(el('div', { class: 'filters' },
    el('div', { class: 'field' }, el('label', {}, 'Year'), ySel),
    el('div', { class: 'field' }, el('label', {}, 'Month'), mSel)));

  const rows = C.budgetStatus(year, month);
  if (!rows.length) {
    host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, icon('target', 40)),
      el('p', {}, 'No budgets yet. Set a monthly ceiling on the categories that run away from you.'),
      el('button', { class: 'btn primary', onclick: () => edit() }, 'Set the first budget')));
    return;
  }
  // Three budgets on Food and Dining used to make one ₹4,831 of spending read
  // as ₹14,493 up here. A figure at the top of a screen is the one people
  // believe, so it counts every riyal once: duplicates fold together, and where
  // a whole category is budgeted, its sub-budgets are already inside it.
  const whole = new Set(rows.filter(r => !r.sub).map(r => r.parent));
  const seen = new Set();
  const forTotals = rows.filter(r => {
    if (r.sub && whole.has(r.parent)) return false;
    const key = `${r.parent}|${r.sub || ''}|${r.period || 'monthly'}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const spent = forTotals.reduce((s, r) => s + r.spent, 0);
  const limit = forTotals.reduce((s, r) => s + r.limit, 0);
  const dupes = rows.length - new Set(rows.map(r => `${r.parent}|${r.sub || ''}|${r.period || 'monthly'}`)).size;
  host.append(el('div', { class: 'grid g3' },
    kpi('Budgeted', money(limit, 'INR', false)),
    kpi('Spent', money(spent, 'INR', false), spent > limit ? 'expense' : ''),
    kpi('Left', money(limit - spent, 'INR', false), limit - spent < 0 ? 'expense' : 'income')));

  if (dupes) {
    host.append(el('div', { class: 'alert slim', style: 'margin-top:10px' },
      el('span', { class: 'ico' }, '⚠'),
      el('div', {}, `${dupes} budget${dupes > 1 ? 's repeat' : ' repeats'} a category that is already budgeted `
        + 'for the same period. Only one ceiling per category can mean anything. ',
      el('a', { href: '#', onclick: e => { e.preventDefault(); dropDuplicates(rows); } },
        'Remove the repeats'))));
  }

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
  restoreFilterFocus(host);   // the cursor stays in the filter you were arrowing through
}

/** Keep the newest of each repeated category; the older ones go. */
async function dropDuplicates(rows) {
  const keep = new Map();
  const drop = [];
  for (const r of rows) {
    const key = `${r.parent}|${r.sub || ''}|${r.period || 'monthly'}`;
    const held = keep.get(key);
    if (!held) { keep.set(key, r); continue; }
    // The newest wins, because that is the one he set last.
    const older = (r.updated_at || '') > (held.updated_at || '') ? held : r;
    if (older === held) keep.set(key, r);
    drop.push(older);
  }
  if (!drop.length) return;
  const names = [...new Set(drop.map(r => r.parent + (r.sub ? ' · ' + r.sub : '')))].join(', ');
  if (!(await confirmBox(`Remove ${drop.length} repeated budget${drop.length > 1 ? 's' : ''} `
    + `(${names}), keeping the one set most recently? No spending is touched.`, 'Remove them'))) return;
  for (const r of drop) await remove('budgets', r.id);
  toast(`${drop.length} removed`);
  draw();
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
  // A sub-category is the thing he remembers; which parent it hangs under is
  // the app's business. So this is a box you type into, and naming a sub that
  // belongs to exactly one category fills that category in above it — the same
  // as the transaction sheet does. A picker that only worked the other way
  // round meant finding the parent first, every time.
  const sub = el('input', { list: 'dl-budget-sub', value: v.sub || '',
    placeholder: 'All sub-categories', autocomplete: 'off' });
  const dl = el('datalist', { id: 'dl-budget-sub' });
  const fillSubs = () => {
    const list = parent.value ? C.subsFor('Expense', parent.value) : C.subsFor('Expense');
    dl.replaceChildren(...list.map(x => el('option', { value: x })));
  };
  const linkParent = () => {
    const name = sub.value.trim();
    if (!name) return;
    // Spelt as the list spells it, so "fuel" saves as "Fuel" and matches.
    const exact = C.subsFor('Expense').find(x => x.toLowerCase() === name.toLowerCase());
    if (exact) sub.value = exact;
    const owners = C.parentsOfSub('Expense', sub.value);
    if (owners.length === 1 && parent.value !== owners[0]) { parent.value = owners[0]; fillSubs(); }
    // Naming the ones it could be beats "this is ambiguous" and a dropdown of fifty.
    else if (owners.length > 1 && !owners.includes(parent.value)) {
      toast(`“${sub.value}” is under ${owners.join(' or ')} — pick which one`, 'warn', 5000);
    }
  };
  sub.addEventListener('change', linkParent);
  sub.addEventListener('blur', linkParent);
  fillSubs();
  parent.onchange = () => { v.sub = ''; sub.value = ''; fillSubs(); };
  const amount = el('input', { type: 'number', step: 'any', value: v.amount || '' });
  const cur = el('select', {}, ...['INR', 'SAR'].map(c => el('option', { value: c, selected: v.currency === c }, c)));
  const period = el('select', {}, el('option', { value: 'monthly', selected: v.period !== 'yearly' }, 'Per month'),
    el('option', { value: 'yearly', selected: v.period === 'yearly' }, 'Per year'));
  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const body = el('div', { class: 'form-grid' },
    fld('Category', parent, 'full'), fld('Sub-category', sub, 'full'), dl,
    fld('Amount', amount), fld('Currency', cur), fld('Period', period, 'full'));
  const m = modal(b ? 'Edit budget' : 'New budget', body, {
    footer: [
      b ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this budget?')) { await remove('budgets', b.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        linkParent();                       // in case Save was reached without leaving the box
        if (!parent.value) return toast('Pick a category', 'warn');
        // One category, one ceiling, per period. A second one does not add a
        // rule — it just counts the same spending twice on this screen.
        const clash = DB.budgets.find(x => x.id !== (b?.id)
          && x.parent === parent.value && (x.sub || null) === (sub.value || null)
          && (x.period || 'monthly') === period.value);
        if (clash) {
          const what = parent.value + (sub.value ? ' · ' + sub.value : '');
          m.close();
          if (await confirmBox(`${what} already has a ${period.value === 'yearly' ? 'yearly' : 'monthly'} budget `
            + `of ${money(clash.currency === 'SAR' ? clash.amount : clash.amount, clash.currency, false)}. `
            + 'Open that one instead?', 'Open it')) edit(clash);
          return;
        }
        await put('budgets', { ...v, parent: parent.value, sub: sub.value || null,
          amount: +amount.value || 0, currency: cur.value, period: period.value });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}
