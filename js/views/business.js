// ============================================================================
//  business.js — P&L per side business (the workbook's Business P&L sheet,
//  including the "add a row to track another business" setup table).
// ============================================================================
import { el, money, num, fmtDate, MONTHS, modal, toast, confirmBox, downloadCSV, todayISO } from '../util.js';
import { DB, put, remove } from '../store.js';
import * as C from '../calc.js';
import { groupedBars, SERIES } from '../charts.js';
import { topbar } from '../app.js';
import { openTxEditor } from './editor.js';
import { kpi } from './report.js';

let pick = 0, f = { year: 'All', month: 'All' };
let host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  const S = SERIES();
  host.innerHTML = '';
  host.append(topbar('Business P&L',
    el('button', { class: 'btn sm', onclick: editBusiness }, '+ Business')));

  if (!DB.businesses.length) {
    host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📊'),
      el('p', {}, 'No businesses set up yet.'),
      el('button', { class: 'btn primary', onclick: editBusiness }, 'Add one')));
    return;
  }
  const biz = DB.businesses[Math.min(pick, DB.businesses.length - 1)];
  const chips = el('div', { class: 'pill-list', style: 'margin-bottom:12px' },
    DB.businesses.map((b, i) => el('button', {
      class: 'chip ' + (i === pick ? 'on' : ''), onclick: () => { pick = i; draw(); },
    }, b.name)));
  host.append(chips);

  const sel = (label, key, opts, all) => {
    const s = el('select', {}, el('option', { value: 'All' }, all),
      ...opts.map(o => el('option', { value: o.v ?? o, selected: String(f[key]) === String(o.v ?? o) }, o.t ?? o)));
    s.onchange = () => { f[key] = s.value; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  host.append(el('div', { class: 'filters' },
    sel('Year', 'year', C.yearsPresent(), 'All years'),
    sel('Month', 'month', MONTHS.map((m, i) => ({ v: i + 1, t: m })), 'All months'),
    el('div', { class: 'field' }, el('label', {}, ' '),
      el('button', { class: 'btn sm', onclick: () => editBusiness(biz) }, '✎ Edit setup'))));

  const pl = C.businessPL(biz, f);
  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('Income ≈ INR', money(pl.income.equiv, 'INR', false), 'income'),
    kpi('Expense ≈ INR', money(pl.expense.equiv, 'INR', false), 'expense'),
    kpi('Net profit', money(pl.netEquiv, 'INR', false), pl.netEquiv >= 0 ? '' : 'expense'),
    kpi('Entries', pl.rows.length.toLocaleString('en-IN'))));

  const chartCard = el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Year by year (≈ INR)')));
  const ch = el('div', {}); chartCard.append(ch); host.append(chartCard);
  requestAnimationFrame(() => groupedBars(ch, {
    labels: pl.byYear.map(y => String(y.year)),
    series: [{ name: '▲ Income', color: S.income, values: pl.byYear.map(y => y.income) },
             { name: '▼ Expense', color: S.expense, values: pl.byYear.map(y => y.expense) }],
  }));

  const yt = el('table');
  yt.append(el('thead', {}, el('tr', {}, el('th', {}, 'Year'), el('th', { class: 'n' }, 'Income'),
    el('th', { class: 'n' }, 'Expense'), el('th', { class: 'n' }, 'Net profit'))));
  const ytb = el('tbody');
  for (const y of pl.byYear) ytb.append(el('tr', {}, el('td', {}, y.year),
    el('td', { class: 'n' }, num(y.income)), el('td', { class: 'n' }, num(y.expense)),
    el('td', { class: 'n ' + (y.net >= 0 ? 'pos' : 'neg') }, num(y.net))));
  ytb.append(el('tr', { class: 'total' }, el('td', {}, 'TOTAL'), el('td', { class: 'n' }, num(pl.income.equiv)),
    el('td', { class: 'n' }, num(pl.expense.equiv)), el('td', { class: 'n' }, num(pl.netEquiv))));
  yt.append(ytb);

  const dt = el('table');
  dt.append(el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Account'),
    el('th', {}, 'Category'), el('th', { class: 'n' }, 'Income'), el('th', { class: 'n' }, 'Expense'), el('th', {}, 'Description'))));
  const dtb = el('tbody');
  for (const r of pl.rows.slice().reverse().slice(0, 300)) {
    dtb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
      el('td', {}, fmtDate(r.date)), el('td', {}, r.account),
      el('td', {}, [r.parent, r.sub].filter(Boolean).join(' · ')),
      el('td', { class: 'n' }, r.income ? num(r.income) + ' ' + r.currency : ''),
      el('td', { class: 'n' }, r.expense ? num(r.expense) + ' ' + r.currency : ''),
      el('td', { class: 'wrap' }, r.note || '')));
  }
  dt.append(dtb);

  host.append(el('div', { class: 'grid g2', style: 'margin-top:12px' },
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Year by year')), el('div', { class: 'table-wrap' }, yt)),
    el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Transactions'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => downloadCSV(`jinnyfin-${biz.name.replace(/\W+/g, '-')}-${todayISO()}.csv`,
        [['Date', 'Type', 'Account', 'Category', 'Sub', 'Currency', 'Income', 'Expense', 'Description'],
          ...pl.rows.map(r => [r.date, r.type, r.account, r.parent || '', r.sub || '', r.currency, r.income || 0, r.expense || 0, r.note || ''])]) }, '⬇')),
      el('div', { class: 'table-wrap', style: 'max-height:56vh;overflow:auto' }, dt))));
}

function editBusiness(biz = null) {
  const b = biz || { name: '', income_parent: '', income_sub: '', expense_parent: '', expense_sub: '' };
  const inp = (v, ph, list) => el('input', { value: v || '', placeholder: ph, list });
  const name = inp(b.name, 'Cake Plans');
  const ip = inp(b.income_parent, 'Income category', 'dl-ip');
  const is = inp(b.income_sub, 'Income sub (optional)');
  const ep = inp(b.expense_parent, 'Expense category', 'dl-ep');
  const es = inp(b.expense_sub, 'Expense sub (optional)');
  const dl = (id, vals) => { const d = el('datalist', { id }); vals.forEach(v => d.append(el('option', { value: v }))); return d; };
  const body = el('div', { class: 'form-grid' },
    el('div', { class: 'field full' }, el('label', {}, 'Business name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Income category'), ip),
    el('div', { class: 'field' }, el('label', {}, 'Income sub-category'), is),
    el('div', { class: 'field' }, el('label', {}, 'Expense category'), ep),
    el('div', { class: 'field' }, el('label', {}, 'Expense sub-category'), es),
    dl('dl-ip', C.parentsFor('Income')), dl('dl-ep', C.parentsFor('Expense')),
    el('p', { class: 'hint full' }, 'Every transaction in those categories is pulled into this P&L automatically.'));
  const m = modal(biz ? 'Edit business' : 'New business', body, {
    footer: [
      biz ? el('button', {
        class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this business?')) { await remove('businesses', biz.id); pick = 0; m.close(); } },
      }, 'Delete') : null,
      el('button', {
        class: 'btn primary', onclick: async () => {
          if (!name.value.trim()) return toast('Give it a name', 'warn');
          await put('businesses', {
            ...b, name: name.value.trim(), income_parent: ip.value.trim() || null, income_sub: is.value.trim() || null,
            expense_parent: ep.value.trim() || null, expense_sub: es.value.trim() || null,
          });
          m.close();
        },
      }, 'Save'),
    ].filter(Boolean),
  });
}
