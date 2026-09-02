// ============================================================================
//  payee.js — Lend / Borrow: who owes whom, every movement per payee, and a
//  statement you can hand to the person on the other side of the debt.
// ============================================================================
import { el, money, num, fmtDate, fmtDateShort, downloadCSV, todayISO, esc, toast } from '../util.js';
import { DB, state, getSettings } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { openTxEditor } from './editor.js';
import { kpi } from './report.js';
import { printStatement, printDate } from './printable.js';

let selected = null, showSettled = false, host = null;
const range = { from: '', to: '' };

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

// ---------------------------------------------------------------- ledger ---
/**
 * One payee's movements between two dates, with the balance carried in from
 * before `from`. A statement without an opening balance is a lie by omission —
 * the other side has to see where the number started.
 */
export function ledgerFor(payee, from = '', to = '') {
  const all = C.payeeLedger(payee);
  const before = from ? all.filter(r => r.date < from) : [];
  const rows = all.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
  const opening = before.length ? before[before.length - 1].balance : 0;
  const inSum = rows.reduce((s, r) => s + (+r.income || 0), 0);
  const outSum = rows.reduce((s, r) => s + (+r.expense || 0), 0);
  const closing = rows.length ? rows[rows.length - 1].balance : opening;
  const currency = (rows[0] || all[0] || {}).currency || 'SAR';
  return { rows, opening, inSum, outSum, closing, currency, total: all.length };
}

/** Positive balance = they took money from me (I lent) → they owe me. */
const standingLine = (payee, bal, cur) =>
  Math.abs(bal) < 0.005 ? `Settled — nothing outstanding between you and ${payee}.`
    : bal < 0 ? `${payee} owes you ${money(Math.abs(bal), cur)}.`
    : `You owe ${payee} ${money(Math.abs(bal), cur)}.`;

// ------------------------------------------------------------------ view ---
function draw() {
  const keep = window.scrollY;
  host.innerHTML = '';
  const lb = C.lendBorrowPositions();
  host.append(topbar('Lend / Borrow',
    el('button', { class: 'btn sm', onclick: () => exportCSV(lb) }, '⬇ CSV'),
    el('button', { class: 'btn sm primary', onclick: () => openTxEditor(null, { type: 'Lend/Borrow', parent: 'Lend', sub: 'Lend' }) }, '+ Entry')));

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('⬆ I owe', money(lb.iOwe, 'INR', false), 'expense'),
    kpi('⬇ They owe me', money(lb.theyOwe, 'INR', false), 'income'),
    kpi('Net position', money(Math.abs(lb.netINR), 'INR', false), lb.netINR < 0 ? 'expense' : 'income'),
    kpi('Open / settled', `${lb.openCount} / ${lb.settledCount}`)));
  host.append(el('p', { class: 'small muted', style: 'margin:8px 0 12px' },
    lb.netINR < 0 ? '➜ On balance you owe money.' : '➜ On balance people owe you money.',
    ' Settled payees are excluded from the net figure — only the exchange-rate noise would remain.'));

  // Older rows carried over from the workbook never had a name typed against
  // them. They are settled history, but the totals above cannot see them — and
  // a total that quietly leaves out three quarters of the entries is a trap.
  const nameless = DB.transactions.filter(x => x.type === 'Lend/Borrow' && !x.payee && !x.deleted).length;
  if (nameless) host.append(el('div', { class: 'alert slim' }, el('span', { class: 'ico' }, 'ℹ️'),
    el('div', {}, `${nameless.toLocaleString('en-IN')} older entries carry no name, so they are not in the figures above. `
      + 'They came across from the workbook already settled — the money itself is in your account balances either way.')));

  const toggle = el('label', { class: 'chip', style: 'cursor:pointer' },
    el('input', { type: 'checkbox', checked: showSettled, onchange: e => { showSettled = e.target.checked; draw(); } }),
    ' show settled');

  // ------------------------------------------------------------- summary --
  const t = el('table');
  t.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Payee'), el('th', {}, 'Currency'), el('th', { class: 'n' }, 'Balance'),
    el('th', { class: 'n' }, '≈ INR'), el('th', {}, 'Status'), el('th', { class: 'n' }, 'Entries'))));
  const tb = el('tbody');
  for (const r of lb.rows) {
    if (!r.open && !showSettled) continue;
    tb.append(el('tr', {
      class: r.payee === selected ? 'picked' : '',
      style: 'cursor:pointer',
      onclick: () => { selected = r.payee; draw(); document.querySelector('#payee-ledger')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    },
      el('td', {}, r.payee), el('td', {}, r.currency),
      el('td', { class: 'n ' + (r.balance > 0 ? 'neg' : r.balance < 0 ? 'pos' : '') }, r.open ? num(r.balance) : '0.00'),
      el('td', { class: 'n muted' }, r.open ? num(r.equivINR) : '–'),
      el('td', {}, r.status === 'i-owe' ? '⬆ I owe them' : r.status === 'they-owe' ? '⬇ They owe me' : '✓ Settled'),
      el('td', { class: 'n muted' }, r.count)));
  }
  t.append(tb);
  host.append(el('div', { class: 'card', style: 'margin-top:4px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Payee balances'), el('div', { class: 'spacer' }), toggle),
    el('div', { class: 'table-wrap' }, t)));

  if (selected) host.append(ledgerCard(lb));
  else host.append(el('p', { class: 'small muted', style: 'margin-top:10px' }, 'Tap a payee to open their ledger.'));

  if (keep) requestAnimationFrame(() => window.scrollTo(0, keep));
}

// ------------------------------------------------------------ one ledger ---
function ledgerCard(lb) {
  const L = ledgerFor(selected, range.from, range.to);
  const pos = lb.rows.find(r => r.payee === selected);
  const cur = pos?.currency || L.currency;
  const lastAcct = L.rows.length ? L.rows[L.rows.length - 1].account : undefined;

  // Which two moves make sense depends on which way the money is owed.
  const act = (label, parent, sub, primary = false) => el('button', {
    class: 'btn sm' + (primary ? ' primary' : ''),
    onclick: () => openTxEditor(null, { type: 'Lend/Borrow', payee: selected, parent, sub, account: lastAcct }),
  }, label);
  const actions = pos?.status === 'they-owe'
    ? [act('+ Collection', 'Lend', 'Collecting debts', true), act('+ Lend more', 'Lend', 'Lend')]
    : pos?.status === 'i-owe'
      ? [act('+ Repayment', 'Borrow', 'Repayment', true), act('+ Borrow more', 'Borrow', 'Borrow')]
      : [act('+ Lend', 'Lend', 'Lend'), act('+ Borrow', 'Borrow', 'Borrow')];

  // ------------------------------------------------------------- period --
  const dateIn = key => {
    const i = el('input', { type: 'date', value: range[key] || '' });
    i.onchange = () => { range[key] = i.value; draw(); };
    return i;
  };
  const quick = (label, from, to) => el('button', {
    class: 'btn sm ghost', onclick: () => { range.from = from; range.to = to; draw(); },
  }, label);
  const y = new Date().getFullYear();
  const periodRow = el('div', { class: 'filters', style: 'margin:0 0 10px' },
    el('div', { class: 'field' }, el('label', {}, 'From'), dateIn('from')),
    el('div', { class: 'field' }, el('label', {}, 'To'), dateIn('to')),
    el('div', { class: 'field', style: 'flex:2 1 260px' }, el('label', {}, 'Quick'),
      el('div', { class: 'row gap wrap' },
        quick('All time', '', ''),
        quick('This year', `${y}-01-01`, todayISO()),
        quick('Last 12 months', new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), todayISO()))));

  // -------------------------------------------------------------- table --
  const lt = el('table');
  lt.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Date'), el('th', {}, 'Account'), el('th', {}, 'Kind'), el('th', {}, 'Description'),
    el('th', { class: 'n' }, 'In (borrowed)'), el('th', { class: 'n' }, 'Out (lent/repaid)'), el('th', { class: 'n' }, 'Balance'))));
  const ltb = el('tbody');
  if (range.from) {
    ltb.append(el('tr', { class: 'muted' },
      el('td', {}, fmtDate(range.from)), el('td', { colspan: 3 }, 'Opening balance'),
      el('td', { class: 'n' }, ''), el('td', { class: 'n' }, ''), el('td', { class: 'n' }, num(L.opening))));
  }
  for (const r of L.rows.slice().reverse()) {
    ltb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
      el('td', {}, fmtDate(r.date)), el('td', {}, r.account),
      el('td', {}, [r.parent, r.sub].filter(Boolean).join(' · ')),
      el('td', { class: 'wrap' }, r.note || ''),
      el('td', { class: 'n' }, r.income ? num(r.income) : ''),
      el('td', { class: 'n' }, r.expense ? num(r.expense) : ''),
      el('td', { class: 'n' }, num(r.balance))));
  }
  lt.append(ltb);

  const totals = el('div', { class: 'grid g4 keep2', style: 'margin:10px 0 4px' },
    kpi('Opening', money(L.opening, cur, false)),
    kpi('▲ In', money(L.inSum, cur, false), 'income'),
    kpi('▼ Out', money(L.outSum, cur, false), 'expense'),
    kpi('Closing', money(L.closing, cur, false), L.closing < 0 ? 'income' : L.closing > 0 ? 'expense' : ''));

  return el('div', { class: 'card', id: 'payee-ledger', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, `Ledger — ${selected}`), el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => { selected = null; draw(); } }, 'Close'),
      ...actions),
    el('p', { class: 'small muted', style: 'margin:-4px 0 10px' },
      (pos?.status === 'they-owe' ? '⬇ ' : pos?.status === 'i-owe' ? '⬆ ' : '✓ ') + standingLine(selected, pos ? pos.balance : L.closing, cur)),
    periodRow,
    totals,
    el('div', { class: 'row gap wrap', style: 'margin:6px 0 10px' },
      el('button', { class: 'btn sm primary', onclick: () => printStatementFor(L, cur) }, '🧾 Statement (print / PDF)'),
      el('button', { class: 'btn sm', onclick: () => statementCSV(L, cur) }, '⬇ CSV'),
      el('span', { class: 'small muted' },
        `${L.rows.length} of ${L.total} entries${range.from || range.to ? ' in this period' : ''}`)),
    el('div', { class: 'table-wrap', style: 'max-height:60vh;overflow:auto' }, lt));
}

// -------------------------------------------------------------- statement --
/**
 * The same branded sheet the account statement prints, so whichever one you
 * hand over looks like it came from the same place.
 */
function printStatementFor(L, cur) {
  const period = range.from || range.to
    ? `${range.from ? printDate(range.from) : 'the beginning'} — ${range.to ? printDate(range.to) : printDate(todayISO())}`
    : 'All time';
  const owed = L.closing;
  const line = Math.abs(owed) < 0.005 ? 'Settled — nothing outstanding.'
    : owed < 0 ? `Balance due from ${esc(selected)}: <b>${money(Math.abs(owed), cur)}</b>`
      : `Balance due to ${esc(selected)}: <b>${money(Math.abs(owed), cur)}</b>`;

  printStatement({
    title: 'Statement of account',
    subtitle: `${selected} · ${cur}`,
    meta: [['Period', period], ['Entries', String(L.rows.length)], ['Currency', cur]],
    head: ['Date', 'Kind', 'Description', 'In', 'Out', 'Balance'], numeric: [3, 4, 5],
    widths: [14, 18, 24, 14, 14, 16],
    opening: ['', '', 'Opening balance', '', '', num(L.opening)],
    rows: L.rows.map(r => [printDate(r.date), [r.parent, r.sub].filter(Boolean).join(' · '),
      r.note || '', r.income ? num(r.income) : '', r.expense ? num(r.expense) : '', num(r.balance)]),
    closing: ['', '', 'Closing balance', num(L.inSum), num(L.outSum), num(L.closing)],
    standing: line,
    note: `“In” is money received from ${esc(selected)}; “Out” is money paid to them. `
        + 'A positive balance is owed to them; a negative balance is owed to you.',
  });
}

function statementCSV(L, cur) {
  const head = ['Date', 'Account', 'Category', 'Sub', 'Description', `In (${cur})`, `Out (${cur})`, `Balance (${cur})`];
  const rows = [['', '', '', '', 'Opening balance', '', '', L.opening.toFixed(2)]];
  for (const r of L.rows) {
    rows.push([r.date, r.account, r.parent || '', r.sub || '', r.note || '',
      r.income ? (+r.income).toFixed(2) : '', r.expense ? (+r.expense).toFixed(2) : '', r.balance.toFixed(2)]);
  }
  rows.push(['', '', '', '', 'Closing balance', L.inSum.toFixed(2), L.outSum.toFixed(2), L.closing.toFixed(2)]);
  const tag = [selected.replace(/[^\w]+/g, '-'), range.from || 'start', range.to || todayISO()].join('_');
  downloadCSV(`jinnyfin-statement-${tag}.csv`, [head, ...rows]);
}

function exportCSV(lb) {
  downloadCSV(`jinnyfin-lend-borrow-${todayISO()}.csv`,
    [['Payee', 'Currency', 'Balance', '≈ INR', 'Status', 'Entries'],
      ...lb.rows.map(r => [r.payee, r.currency, r.open ? r.balance : 0, r.open ? r.equivINR.toFixed(2) : 0, r.status, r.count])]);
}
