// ============================================================================
//  payee.js — Lend / Borrow: who owes whom, every movement per payee, and a
//  statement you can hand to the person on the other side of the debt.
// ============================================================================
import { el, money, num, fmtDate, fmtDateShort, downloadCSV, todayISO, esc, toast,
  dateGuard, restoreDateFocus, dateBox, modal, confirmBox } from '../util.js';
import { DB, state, getSettings, put, putMany, remove } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { openTxEditor } from './editor.js';
import { kpi } from './report.js';
import { printStatement, printDate } from './printable.js';
import { icon } from '../icons.js';

let selected = null, showSettled = false, host = null;
let side = 'all';                       // all | lend | borrow — which half of the relationship
let ccy = 'all';                        // all | SAR | INR | … — which currency of it
const range = { from: '', to: '' };

// One relationship can run both ways at once: money you lent him, and money you
// borrowed from him. Each is a whole debt with its own two directions —
// Lend/Collecting debts on one side, Borrow/Repayment on the other — so each can
// be read, totalled and handed over as a statement by itself. Their two closing
// balances still add up to the net figure; nothing is invented by splitting.
export const sideOf = r => {
  const s = `${r.parent || ''} ${r.sub || ''}`.toLowerCase();
  if (/lend|collect/.test(s)) return 'lend';
  if (/borrow|repay/.test(s)) return 'borrow';
  return 'other';                       // old rows that never carried a label
};
const SIDE = {
  all: { chip: 'All', title: 'Statement of account', line: '' },
  lend: { chip: '⬇ They owe me', title: 'Amounts due from',
    line: 'This statement covers only what was lent and collected back. '
      + 'Anything borrowed from them is a separate account with its own statement.' },
  borrow: { chip: '⬆ I owe them', title: 'Amounts due to',
    line: 'This statement covers only what was borrowed and repaid. '
      + 'Anything lent to them is a separate account with its own statement.' },
};

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

// ---------------------------------------------------------------- ledger ---
/**
 * One payee's movements between two dates, with the balance carried in from
 * before `from`. A statement without an opening balance is a lie by omission —
 * the other side has to see where the number started.
 */
export function ledgerFor(payee, from = '', to = '', half = 'all', onlyCur = 'all') {
  let all = C.payeeLedger(payee);
  const unplaced = all.filter(r => sideOf(r) === 'other').length;
  if (half !== 'all') {
    // The running balance has to be re-walked over this half alone, or the
    // column would still be carrying the other half's movements.
    const run = new Map();
    all = all.filter(r => sideOf(r) === half).map(r => {
      const c = r.currency || 'SAR';
      run.set(c, (run.get(c) || 0) + (+r.income || 0) - (+r.expense || 0));
      return { ...r, balance: Math.round(run.get(c) * 100) / 100 };
    });
  }
  // The currencies this side was dealt in — what the picker may offer, and
  // read before the picker narrows it, or it would only ever offer itself.
  const currencies = [...new Set(all.map(r => r.currency || 'SAR'))];
  if (onlyCur !== 'all') all = all.filter(r => (r.currency || 'SAR') === onlyCur);
  const before = from ? all.filter(r => r.date < from) : [];
  const rows = all.filter(r => (!from || r.date >= from) && (!to || r.date <= to));
  const cur1 = r => r.currency || 'SAR';
  // One set of figures per currency this payee has been dealt in. Usually that
  // is one and the screen looks exactly as it always did; two means the person
  // was lent both riyals and rupees, and those two sums must never meet — a
  // total of "5,030" made of ₹5,000 and ﷼30 is not a number about anything.
  const cur = [...new Set(all.map(cur1))].map(c => {
    const mine = rows.filter(r => cur1(r) === c);
    const pre = before.filter(r => cur1(r) === c);
    const opening = pre.length ? pre[pre.length - 1].balance : 0;
    return {
      currency: c, opening, count: mine.length,
      inSum: mine.reduce((s, r) => s + (+r.income || 0), 0),
      outSum: mine.reduce((s, r) => s + (+r.expense || 0), 0),
      closing: mine.length ? mine[mine.length - 1].balance : opening,
    };
  }).filter(c => c.count || Math.abs(c.opening) >= 0.005);
  const main = cur[0] || { currency: 'SAR', opening: 0, inSum: 0, outSum: 0, closing: 0 };
  return { rows, cur, total: all.length, mixed: cur.length > 1, half, unplaced, currencies,
    // What the rest of the screen already speaks, for the ordinary one-currency
    // payee. Never read these when `mixed` is true.
    currency: main.currency, opening: main.opening,
    inSum: main.inSum, outSum: main.outSum, closing: main.closing };
}

/**
 * Positive balance = they took money from me (I lent) → they owe me.
 * Said once per currency: a debt of ﷼30 and a debt of ₹5,000 are two debts.
 */
const standingLine = (payee, cur) => {
  const open = cur.filter(c => Math.abs(c.closing) >= 0.005);
  if (!open.length) return `Settled — nothing outstanding between you and ${payee}.`;
  const list = a => a.map(c => money(Math.abs(c.closing), c.currency)).join(' and ');
  const theyOwe = open.filter(c => c.closing < 0);
  const iOwe = open.filter(c => c.closing > 0);
  const parts = [];
  if (theyOwe.length) parts.push(`${payee} owes you ${list(theyOwe)}`);
  if (iOwe.length) parts.push(`you owe ${payee} ${list(iOwe)}`);
  return parts.join(', and ') + '.';
};

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
    lb.netINR < 0 ? '➜ On balance you owe money.' : '➜ On balance people owe you money.'));

  // Older rows carried over from the workbook never had a name typed against
  // them. They are settled history, but the totals above cannot see them — and
  // a total that quietly leaves out three quarters of the entries is a trap.
  const nameless = DB.transactions.filter(x => x.type === 'Lend/Borrow' && !x.payee && !x.deleted).length;
  if (nameless) host.append(el('div', { class: 'alert slim' }, el('span', { class: 'ico' }, 'ℹ️'),
    el('div', {}, `${nameless.toLocaleString('en-IN')} older entries have no name — not in these totals. `,
      el('a', { href: '#/settings?tab=check' }, 'Show them'))));

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
      onclick: () => { selected = r.payee; side = 'all'; ccy = 'all'; draw(); document.querySelector('#payee-ledger')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    },
      el('td', {}, el('span', { class: 'row gap', style: 'align-items:center;gap:6px' },
        el('span', {}, r.payee),
        el('button', {
          class: 'icon-btn sm', title: `Rename ${r.payee}`, 'aria-label': `Rename ${r.payee}`,
          onclick: e => { e.stopPropagation(); renamePayee(r.payee); },
        }, icon('pencil', 14)))), el('td', {}, r.currency),
      // Every open currency, side by side. The colour follows the INR
      // equivalent, which is the only figure that can judge the two together.
      el('td', { class: 'n ' + (r.equiv > 0 ? 'neg' : r.equiv < 0 ? 'pos' : '') },
        r.open ? r.parts.map(p => num(p.balance)).join('  /  ') : '0.00'),
      el('td', { class: 'n muted' }, r.open ? num(r.equivINR) : '–'),
      el('td', {}, r.status === 'i-owe' ? '⬆ I owe them'
        : r.status === 'they-owe' ? '⬇ They owe me'
          : r.status === 'both' ? '⇅ Both ways' : '✓ Settled'),
      el('td', { class: 'n muted' }, r.count)));
  }
  t.append(tb);
  host.append(el('div', { class: 'card', style: 'margin-top:4px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Payee balances'), el('div', { class: 'spacer' }), toggle),
    el('div', { class: 'table-wrap' }, t)));

  if (selected) host.append(ledgerCard(lb));
  else host.append(el('p', { class: 'small muted', style: 'margin-top:10px' }, 'Tap a payee to open their ledger.'));

  if (keep) requestAnimationFrame(() => window.scrollTo(0, keep));
  restoreDateFocus(host);        // put the cursor back in the date box the redraw ate
}

// --------------------------------------------------------- rename / merge ---
/** Every payee name the ledger actually uses, spelt as it is spelt there. */
const payeeNames = () => [...new Set(DB.transactions
  .filter(t => t.payee && !t.deleted).map(t => t.payee))];

const entriesOf = name => DB.transactions.filter(t => t.payee === name && !t.deleted);

/** What the two sides add up to, per currency — never across them. */
function combinedLine(a, b) {
  const sum = new Map();
  for (const c of [...ledgerFor(a).cur, ...ledgerFor(b).cur]) {
    sum.set(c.currency, (sum.get(c.currency) || 0) + c.closing);
  }
  const parts = [...sum].filter(([, v]) => Math.abs(v) >= 0.005)
    .map(([c, v]) => `${money(Math.abs(v), c)} ${v > 0 ? 'you owe' : 'owed to you'}`);
  return parts.length ? parts.join(', ') : 'nothing outstanding';
}

/**
 * Rename a payee across every entry that carries the name. Typing a name that
 * already exists is a merge, and a merge is never done on the rename confirm
 * alone — it asks again, by itself, naming both sides and the joint balance.
 */
function renamePayee(name) {
  const input = el('input', { type: 'text', value: name, maxlength: 80, autocomplete: 'off' });
  const m = modal('Rename payee',
    el('div', { class: 'form-grid' },
      el('div', { class: 'field full' }, el('label', {}, 'Name'), input),
      el('p', { class: 'hint full', style: 'margin:0' },
        `${entriesOf(name).length.toLocaleString('en-IN')} entries · type another payee's name to merge.`)),
    { footer: [el('button', { class: 'btn primary', onclick: () => save() }, 'Save')] });
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  setTimeout(() => { input.focus(); input.select(); }, 30);

  async function save() {
    const next = input.value.trim();
    if (!next) return toast('Name?', 'warn');
    if (next === name) return m.close();
    const rows = entriesOf(name);
    const hit = payeeNames().find(p => p !== name && p.toLowerCase() === next.toLowerCase());

    if (hit) {
      const ok = await confirmBox(
        `“${hit}” already exists. Merge “${name}” (${rows.length.toLocaleString('en-IN')} entries) `
        + `into “${hit}” (${entriesOf(hit).length.toLocaleString('en-IN')} entries)? `
        + `The two balances become one: ${combinedLine(name, hit)}. This cannot be undone.`,
        'Yes, merge them');
      if (!ok) return;
      if (rows.length) await putMany('transactions', rows.map(t => ({ ...t, payee: hit })));
      const old = DB.payees.find(p => p.name === name);
      if (old) await remove('payees', old.id);
      if (selected === name) selected = hit;
      toast(`Merged into ${hit}`);
    } else {
      const ok = await confirmBox(
        `Rename “${name}” to “${next}” on ${rows.length.toLocaleString('en-IN')} entries?`, 'Yes, rename');
      if (!ok) return;
      if (rows.length) await putMany('transactions', rows.map(t => ({ ...t, payee: next })));
      const old = DB.payees.find(p => p.name === name);
      await put('payees', old ? { ...old, name: next } : { name: next });
      if (selected === name) selected = next;
      toast('Renamed');
    }
    m.close();
    draw();
  }
}

// ------------------------------------------------------------ one ledger ---
function ledgerCard(lb) {
  const L = ledgerFor(selected, range.from, range.to, side, ccy);
  const lastAcct = L.rows.length ? L.rows[L.rows.length - 1].account : undefined;
  // Which way the money is owed, read off the ledger itself rather than the
  // summary row — the summary picks one currency to show and would call a
  // person "settled" while a debt in the other currency is still open.
  const openCur = L.cur.filter(c => Math.abs(c.closing) >= 0.005);
  const owedWay = !openCur.length ? 'settled'
    : openCur.every(c => c.closing < 0) ? 'they-owe'
      : openCur.every(c => c.closing > 0) ? 'i-owe' : 'both';

  // Which two moves make sense depends on which way the money is owed.
  const act = (label, parent, sub, primary = false) => el('button', {
    class: 'btn sm' + (primary ? ' primary' : ''),
    onclick: () => openTxEditor(null, { type: 'Lend/Borrow', payee: selected, parent, sub, account: lastAcct }),
  }, label);
  const actions = owedWay === 'they-owe'
    ? [act('+ Collection', 'Lend', 'Collecting debts', true), act('+ Lend more', 'Lend', 'Lend')]
    : owedWay === 'i-owe'
      ? [act('+ Repayment', 'Borrow', 'Repayment', true), act('+ Borrow more', 'Borrow', 'Borrow')]
      : [act('+ Lend', 'Lend', 'Lend'), act('+ Borrow', 'Borrow', 'Borrow')];

  // ------------------------------------------------------------- period --
  const dateIn = key => {
    const i = dateBox({ value: range[key] || '' });
    dateGuard(i, v => {
      if (v === (range[key] || '')) return;
      range[key] = v; draw();
    }, key);
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
        quick('Last 12 months', new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), todayISO()))),
    el('div', { class: 'field', style: 'flex:3 1 340px' }, el('label', {}, 'Side of the account'),
      el('div', { class: 'row gap wrap', style: 'align-items:center' },
        ...['all', 'lend', 'borrow'].map(k => el('button', {
          class: 'btn sm' + (side === k ? ' primary' : ' ghost'),
          onclick: () => {
            side = k;
            if (ccy !== 'all' && !ledgerFor(selected, '', '', k).currencies.includes(ccy)) ccy = 'all';
            draw();
          },
        }, SIDE[k].chip)),
        // One payee, two currencies, is the only case where this is a question
        // worth asking — so the picker appears only then, and takes a corner.
        L.currencies.length > 1
          ? el('select', { style: 'margin-left:auto;max-width:132px',
            onchange: e => { ccy = e.target.value; draw(); } },
          ...['all', ...L.currencies].map(c => el('option',
            { value: c, selected: ccy === c }, c === 'all' ? 'All currencies' : c)))
          : null)));

  // -------------------------------------------------------------- table --
  const lt = el('table');
  lt.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Date'), el('th', {}, 'Account'), el('th', {}, 'Kind'), el('th', {}, 'Description'),
    // The Balance column runs per currency, so when there are two of them the
    // reader has to be told which one each line belongs to.
    ...(L.mixed ? [el('th', {}, 'Cur')] : []),
    el('th', { class: 'n' }, 'In (borrowed)'), el('th', { class: 'n' }, 'Out (lent/repaid)'), el('th', { class: 'n' }, 'Balance'))));
  const ltb = el('tbody');
  if (range.from) {
    for (const c of L.cur) {
      ltb.append(el('tr', { class: 'muted' },
        el('td', {}, fmtDate(range.from)), el('td', { colspan: 3 }, 'Opening balance'),
        ...(L.mixed ? [el('td', {}, c.currency)] : []),
        el('td', { class: 'n' }, ''), el('td', { class: 'n' }, ''), el('td', { class: 'n' }, num(c.opening))));
    }
  }
  for (const r of L.rows.slice().reverse()) {
    ltb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
      el('td', {}, fmtDate(r.date)), el('td', {}, r.account),
      el('td', {}, [r.parent, r.sub].filter(Boolean).join(' · ')),
      el('td', { class: 'wrap' }, r.note || ''),
      ...(L.mixed ? [el('td', {}, r.currency || 'SAR')] : []),
      el('td', { class: 'n in' }, r.income ? num(r.income) : ''),
      el('td', { class: 'n out' }, r.expense ? num(r.expense) : ''),
      // On this page a balance is a debt, not an account: above zero means you
      // owe it. So it follows the same reading as the Payee balances table —
      // red for what you owe, green for what is owed to you — rather than the
      // plain "below zero is red" an account statement uses.
      el('td', { class: 'n ' + (r.balance > 0 ? 'neg' : r.balance < 0 ? 'pos' : '') }, num(r.balance))));
  }
  lt.append(ltb);

  // One row of figures per currency. A payee dealt with in riyals only sees
  // exactly what he always saw; one dealt with in both gets two rows, because
  // there is no honest way to put both debts on one line.
  const totals = el('div', {}, ...L.cur.map(c => el('div',
    { class: 'grid g4 keep2', style: 'margin:10px 0 4px' },
    kpi(L.mixed ? `Opening · ${c.currency}` : 'Opening', money(c.opening, c.currency, false)),
    kpi('▲ In', money(c.inSum, c.currency, false), 'income'),
    kpi('▼ Out', money(c.outSum, c.currency, false), 'expense'),
    kpi('Closing', money(c.closing, c.currency, false),
      c.closing < 0 ? 'income' : c.closing > 0 ? 'expense' : ''))));

  return el('div', { class: 'card', id: 'payee-ledger', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, `Ledger — ${selected}`
      + (side === 'all' ? '' : side === 'lend' ? ' · they owe me' : ' · I owe them')), el('div', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => { selected = null; draw(); } }, 'Close'),
      ...actions),
    el('p', { class: 'small muted', style: 'margin:-4px 0 10px' },
      { 'they-owe': '⬇ ', 'i-owe': '⬆ ', both: '⇅ ', settled: '✓ ' }[owedWay]
      + standingLine(selected, L.cur)
      + (side === 'all' ? '' : ' ' + SIDE[side].line)),
    periodRow,
    // Rows from the old workbook that never carried a Lend or Borrow label
    // cannot be put on either side. They stay in All, and the reader is told.
    side !== 'all' && L.unplaced
      ? el('div', { class: 'alert slim' }, el('span', { class: 'ico' }, 'ℹ️'),
        el('div', {}, `${L.unplaced} entries have no Lend/Borrow label — see All.`))
      : null,
    totals,
    el('div', { class: 'row gap wrap', style: 'margin:6px 0 10px' },
      el('button', { class: 'btn sm primary', onclick: () => printStatementFor(L) }, icon('receipt', 15), ' Statement (print / PDF)'),
      el('button', { class: 'btn sm', onclick: () => statementCSV(L) }, '⬇ CSV'),
      el('span', { class: 'small muted' },
        `${L.rows.length} of ${L.total} entries${range.from || range.to ? ' in this period' : ''}`)),
    el('div', { class: 'table-wrap', style: 'max-height:60vh;overflow:auto' }, lt));
}

// -------------------------------------------------------------- statement --
/**
 * The same branded sheet the account statement prints, so whichever one you
 * hand over looks like it came from the same place.
 */
function printStatementFor(L) {
  const period = range.from || range.to
    ? `${range.from ? printDate(range.from) : 'the beginning'} — ${range.to ? printDate(range.to) : printDate(todayISO())}`
    : 'All time';
  // A statement handed to someone has to be true in each currency separately.
  const open = L.cur.filter(c => Math.abs(c.closing) >= 0.005);
  const say = a => a.map(c => `<b>${money(Math.abs(c.closing), c.currency)}</b>`).join(' and ');
  const due = open.filter(c => c.closing < 0), owe = open.filter(c => c.closing > 0);
  const bits = [];
  if (due.length) bits.push(`Balance due from ${esc(selected)}: ${say(due)}`);
  if (owe.length) bits.push(`Balance due to ${esc(selected)}: ${say(owe)}`);
  const line = bits.length ? bits.join('. ') : 'Settled — nothing outstanding.';

  const cur = L.cur.map(c => c.currency).join(' + ');
  const C0 = L.mixed ? ['Cur'] : [];
  const body = L.rows.map(r => [printDate(r.date), [r.parent, r.sub].filter(Boolean).join(' · '),
    r.note || '', ...(L.mixed ? [r.currency || 'SAR'] : []),
    r.income ? num(r.income) : '', r.expense ? num(r.expense) : '', num(r.balance)]);
  // printStatement takes one opening and one closing row, so with two
  // currencies those lines go into the body instead — one pair per currency.
  const pad = (label, c, a, b, bal) => ['', '', label, ...(L.mixed ? [c] : []), a, b, bal];

  printStatement({
    title: side === 'all' ? 'Statement of account' : `${SIDE[side].title} ${esc(selected)}`,
    subtitle: `${selected} · ${cur}`
      + (side === 'all' ? '' : side === 'lend' ? ' · lent and collected' : ' · borrowed and repaid'),
    meta: [['Period', period], ['Entries', String(L.rows.length)], ['Currency', cur],
      ...(side === 'all' ? [] : [['Covers', side === 'lend' ? 'Lend · Collecting debts' : 'Borrow · Repayment']])],
    head: ['Date', 'Kind', 'Description', ...C0, 'In', 'Out', 'Balance'],
    numeric: L.mixed ? [4, 5, 6] : [3, 4, 5],
    widths: L.mixed ? [13, 16, 21, 8, 13, 13, 16] : [14, 18, 24, 14, 14, 16],
    opening: L.mixed ? null : pad('Opening balance', '', '', '', num(L.opening)),
    rows: L.mixed
      ? [...L.cur.map(c => pad(`Opening balance · ${c.currency}`, c.currency, '', '', num(c.opening))),
        ...body,
        ...L.cur.map(c => pad(`Closing balance · ${c.currency}`, c.currency,
          num(c.inSum), num(c.outSum), num(c.closing)))]
      : body,
    closing: L.mixed ? null : pad('Closing balance', '', num(L.inSum), num(L.outSum), num(L.closing)),
    standing: line,
    note: `“In” is money received from ${esc(selected)}; “Out” is money paid to them. `
        + 'A positive balance is owed to them; a negative balance is owed to you.'
        + (L.mixed ? ' Each currency carries its own running balance; the two are never added together.' : '')
        + (side === 'all' ? '' : ' ' + SIDE[side].line),
  });
}

function statementCSV(L) {
  const head = ['Date', 'Account', 'Category', 'Sub', 'Description', 'Currency', 'In', 'Out', 'Balance'];
  const rows = L.cur.map(c => ['', '', '', '', 'Opening balance', c.currency, '', '', c.opening.toFixed(2)]);
  for (const r of L.rows) {
    rows.push([r.date, r.account, r.parent || '', r.sub || '', r.note || '', r.currency || 'SAR',
      r.income ? (+r.income).toFixed(2) : '', r.expense ? (+r.expense).toFixed(2) : '', r.balance.toFixed(2)]);
  }
  for (const c of L.cur) {
    rows.push(['', '', '', '', 'Closing balance', c.currency,
      c.inSum.toFixed(2), c.outSum.toFixed(2), c.closing.toFixed(2)]);
  }
  const tag = [selected.replace(/[^\w]+/g, '-'), ...(side === 'all' ? [] : [side]),
    ...(ccy === 'all' ? [] : [ccy]),
    range.from || 'start', range.to || todayISO()].join('_');
  downloadCSV(`jinnyfin-statement-${tag}.csv`, [head, ...rows]);
}

function exportCSV(lb) {
  downloadCSV(`jinnyfin-lend-borrow-${todayISO()}.csv`,
    [['Payee', 'Currency', 'Balance', '≈ INR', 'Status', 'Entries'],
      ...lb.rows.map(r => [r.payee, r.currency,
        r.open ? r.parts.map(p => p.balance.toFixed(2)).join(' / ') : '0.00',
        r.open ? r.equivINR.toFixed(2) : 0, r.status, r.count])]);
}
