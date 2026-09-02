// ============================================================================
//  statement.js — account statement with a running balance.
// ============================================================================
import { el, money, num, fmtDate, MONTHS, downloadCSV, todayISO, endOfMonth } from '../util.js';
import { printStatement, printDate } from './printable.js';
import { DB } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { openTxEditor, typeIcon } from './editor.js';
import { kpi } from './report.js';

let f = { account: '', tag: '', from: '', to: '', month: 'All', year: 'All' };
let host = null, showClosed = false;

/** What is open lives in the address, not in a variable — so a background sync,
 *  an Alt-Tab, or the back gesture cannot quietly throw you back to the list. */
function readUrl() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  f.account = q.get('account') || '';
  f.tag = q.get('tag') || '';
}
function openThing(kind, name) {
  f.from = f.to = ''; f.year = f.month = 'All';
  location.hash = name ? `#/statement?${kind}=${encodeURIComponent(name)}` : '#/statement';
  readUrl(); draw(); window.scrollTo(0, 0);
}

export async function render(root) { host = root; readUrl(); draw(); }
export function refresh() { if (host) { readUrl(); draw(); } }

// Esc leaves whatever statement is open the same way the back gesture does —
// which lands you back where you came from, Net Worth included.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!host || !host.isConnected) return;
  if (document.querySelector('.modal-wrap')) return;      // a sheet owns Esc first
  if (!f.account && !f.tag) return;
  history.back();
});

function draw() { f.tag ? drawHolding() : f.account ? drawOne() : drawList(); }

// --------------------------------------------------------- all accounts ----
/**
 * The first thing you want from "Account Statement" is not one account — it is
 * where all the money currently sits. Pick a row to open its statement.
 */
/** "1 entry", not "1 entries". */
const entries = n => `${n} ${n === 1 ? 'entry' : 'entries'}`;

function drawList() {
  host.innerHTML = '';
  host.append(topbar('Account Statement'));

  const bals = C.allAccountBalances();
  const seen = C.lastActivity();
  const status = new Map(DB.accounts.map(a => [a.name, C.accountStatus(a, seen)]));
  const all = DB.accounts.filter(a => showClosed || status.get(a.name).live);
  const rate = C.rates().sar;
  const inr = a => (a.currency === 'SAR' ? (bals.get(a.name) || 0) * rate
    : a.currency === 'USD' ? (bals.get(a.name) || 0) * C.rates().usd * rate
      : (bals.get(a.name) || 0));

  const GROUPS = [['primary', 'Cash & bank'], ['investment', 'Investment'], [null, 'Other']];
  let total = 0;

  const cards = [];
  for (const [key, label] of GROUPS) {
    const list = all.filter(a => (key ? a.grp === key : !a.grp || !['primary', 'investment'].includes(a.grp)))
      .sort((x, y) => x.name.localeCompare(y.name));
    if (!list.length) continue;
    const sum = list.reduce((n, a) => n + inr(a), 0);
    total += sum;

    const t = el('table', { class: 'bal-table' });
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Account'), el('th', { class: 'n' }, 'Balance'), el('th', { class: 'n' }, '≈ INR'))));
    const tb = el('tbody');
    for (const a of list) {
      const bal = bals.get(a.name) || 0;
      const n = DB.transactions.filter(x => x.account === a.name).length;
      const st = status.get(a.name);
      tb.append(el('tr', {
        class: st.live ? '' : 'muted', style: 'cursor:pointer',
        onclick: () => openThing('account', a.name),
      },
        el('td', {}, a.name,
          st.live ? null : el('span', { class: 'small muted', title: st.why }, ' · idle'),
          el('div', { class: 'small muted' }, entries(n))),
        el('td', { class: 'n ' + (bal < 0 ? 'neg' : '') }, money(bal, a.currency)),
        el('td', { class: 'n muted' }, a.currency === 'INR' ? '' : money(inr(a), 'INR', false))));
    }
    t.append(tb);
    cards.push(el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, label), el('div', { class: 'spacer' }),
        el('span', { class: 'small muted' }, money(sum, 'INR', false))),
      el('div', { class: 'table-wrap' }, t)));
  }

  // ---- holdings: money that lives in a fund or an asset, not an account ----
  const hs = C.holdings().map(h => ({ ...h, L: C.holdingLedger(h.tag) }))
    .filter(h => h.L.total || Math.abs(h.L.closing) > 0.01);
  for (const kind of ['investment', 'asset']) {
    const list = hs.filter(h => h.kind === kind);
    if (!list.length) continue;
    const sum = list.reduce((n, h) => n + h.L.closing, 0);
    total += sum;
    const t = el('table', { class: 'bal-table' });
    t.append(el('thead', {}, el('tr', {},
      el('th', {}, kind === 'investment' ? 'Holding' : 'Asset'),
      el('th', { class: 'n' }, 'Paid in'), el('th', { class: 'n' }, 'Balance'))));
    const tb = el('tbody');
    for (const h of list) {
      tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openThing('tag', h.tag) },
        el('td', {}, h.name, el('div', { class: 'small muted' }, entries(h.L.total))),
        el('td', { class: 'n muted' }, money(h.L.inSum, 'INR', false)),
        el('td', { class: 'n' }, money(h.L.closing, 'INR', false))));
    }
    t.append(tb);
    cards.push(el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, kind === 'investment' ? 'Investments' : 'Fixed assets'),
        el('div', { class: 'spacer' }), el('span', { class: 'small muted' }, money(sum, 'INR', false))),
      el('div', { class: 'table-wrap' }, t)));
  }

  const closedCount = DB.accounts.filter(a => !status.get(a.name).live).length;
  host.append(el('div', { class: 'grid g3 keep2', style: 'margin-bottom:12px' },
    kpi('Accounts shown', String(all.length)),
    kpi('Total ≈ INR', money(total, 'INR', false), total < 0 ? 'expense' : 'income'),
    kpi('As of', fmtDate(todayISO()))));

  host.append(el('label', { class: 'chip', style: 'cursor:pointer;margin-bottom:12px;display:inline-flex' },
    el('input', { type: 'checkbox', checked: showClosed, onchange: e => { showClosed = e.target.checked; draw(); } }),
    ` show idle accounts (${closedCount})`));

  host.append(...cards);
  host.append(el('p', { class: 'small muted' }, 'Tap anything here to see every movement behind its balance.'));
}

/** The same year / month / from / to row on every statement. */
function periodFilters() {
  const sel = (label, key, opts, all) => {
    const s = el('select', {}, all ? el('option', { value: 'All' }, all) : null,
      ...opts.map(o => el('option', { value: o.v ?? o, selected: String(f[key]) === String(o.v ?? o) }, o.t ?? o)));
    s.onchange = () => { f[key] = s.value; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  const dateIn = (label, key) => {
    const i = el('input', { type: 'date', value: f[key] || '' });
    i.onchange = () => { f[key] = i.value; f.year = 'All'; f.month = 'All'; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), i);
  };
  return el('div', { class: 'filters' },
    sel('Year', 'year', C.yearsPresent(), 'All years'),
    sel('Month', 'month', MONTHS.map((m, i) => ({ v: i + 1, t: m })), 'All months'),
    dateIn('From', 'from'), dateIn('To', 'to'),
    el('div', { class: 'field' }, el('label', {}, ' '),
      el('button', { class: 'btn sm', onclick: () => { f.from = f.to = ''; f.month = f.year = 'All'; draw(); } }, 'Clear')));
}

// ------------------------------------------------------------- a holding ---
/**
 * Where a fund's or an asset's balance actually came from. These are tracked by
 * category, not by account — the money left a bank and was tagged with the
 * holding's name — so this reads `parent`, and the account column shows which
 * bank each payment came out of.
 */
function drawHolding() {
  host.innerHTML = '';
  const h = C.holdings().find(x => x.tag === f.tag) || { tag: f.tag, kind: 'investment', name: f.tag };
  let from = f.from, to = f.to;
  if (f.year !== 'All') {
    const y = +f.year;
    if (f.month !== 'All') { from = `${y}-${String(f.month).padStart(2, '0')}-01`; to = endOfMonth(y, +f.month); }
    else { from = `${y}-01-01`; to = `${y}-12-31`; }
  }
  const L = C.holdingLedger(f.tag, { from, to });

  host.append(topbar(h.name,
    el('button', { class: 'btn sm ghost', onclick: () => openThing('') }, '← All accounts'),
    el('button', { class: 'btn sm', onclick: () => printHolding(h, L, from, to) }, '🧾 Print / PDF'),
    el('button', { class: 'btn sm', onclick: () => exportHolding(h, L) }, '⬇ CSV')));

  host.append(periodFilters());

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('Opening', money(L.opening, 'INR', false)),
    kpi('Paid in', money(L.inSum, 'INR', false), 'expense'),
    kpi('Taken out', money(L.outSum, 'INR', false), 'income'),
    kpi('Balance now', money(L.closing, 'INR', false))));
  host.append(el('p', { class: 'small muted', style: 'margin:8px 0 12px' },
    h.kind === 'investment'
      ? 'Every payment into this fund and every return out of it. The account column is the bank the money moved through.'
      : 'Everything spent on this asset. The account column is the bank the money came from.'));

  // phone: a list; wide screen: the table
  const list = el('div', { class: 'stmt-list' });
  let day = null;
  const rows = L.rows.slice().reverse();
  for (const r of rows) {
    if (r.date !== day) { day = r.date; list.append(el('div', { class: 'tx-day' }, fmtDate(day))); }
    const out = r.move >= 0;
    list.append(el('div', { class: 'tx', onclick: () => openTxEditor(r) },
      el('div', { class: 'av' }, typeIcon(r.type)),
      el('div', { style: 'min-width:0' },
        el('div', { class: 't1' }, r.note || r.sub || r.type),
        el('div', { class: 't2' }, [r.account, r.sub].filter(Boolean).join(' · '))),
      el('div', { class: 'amt ' + (out ? 'out' : 'in') },
        (out ? '+' : '−') + money(Math.abs(r.move), 'INR'),
        el('span', { class: 'sub bal' }, '(' + num(r.balance) + ')'))));
  }

  // Cost carried in from before the ledger started has no transaction to show,
  // so it gets a line of its own — otherwise the balance looks unexplained.
  if (L.priorCost) {
    list.append(el('div', { class: 'tx' },
      el('div', { class: 'av' }, '🏁'),
      el('div', { style: 'min-width:0' },
        el('div', { class: 't1' }, 'Cost before this ledger began'),
        el('div', { class: 't2' }, 'Opening cost on the asset')),
      el('div', { class: 'amt out' }, '+' + money(L.priorCost, 'INR'))));
  }

  const t = el('table');
  t.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Date'), el('th', {}, 'From account'), el('th', {}, 'Kind'), el('th', {}, 'Description'),
    el('th', { class: 'n' }, 'Paid in'), el('th', { class: 'n' }, 'Taken out'), el('th', { class: 'n' }, 'Balance'))));
  const tb = el('tbody');
  for (const r of rows) {
    const d = r.move;
    tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
      el('td', {}, fmtDate(r.date)), el('td', {}, r.account || ''), el('td', {}, r.sub || r.type),
      el('td', { class: 'wrap' }, r.note || ''),
      el('td', { class: 'n' }, d > 0 ? num(d) : ''),
      el('td', { class: 'n' }, d < 0 ? num(-d) : ''),
      el('td', { class: 'n' }, num(r.balance))));
  }
  // Oldest last, so the carried-in cost sits under everything it paid for.
  if (L.priorCost) tb.append(el('tr', { class: 'total' },
    el('td', {}, '—'), el('td', {}, ''), el('td', {}, 'Opening'),
    el('td', { class: 'wrap' }, 'Cost before this ledger began'),
    el('td', { class: 'n' }, num(L.priorCost)), el('td', { class: 'n' }, ''),
    el('td', { class: 'n' }, num(L.priorCost))));
  t.append(tb);

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, `${h.name} · ${entries(L.total)}`)),
    list, el('div', { class: 'table-wrap stmt-table', style: 'max-height:70vh;overflow:auto' }, t)));

  if (!L.total && !L.priorCost) host.append(el('div', { class: 'empty' },
    el('div', { class: 'big' }, '📄'), el('p', {}, 'Nothing in this period.')));
}

function printHolding(h, L, from, to) {
  const period = (from || to)
    ? `${from ? printDate(from) : 'the beginning'} — ${to ? printDate(to) : printDate(todayISO())}`
    : 'All time';
  printStatement({
    title: h.kind === 'investment' ? 'Investment statement' : 'Asset statement',
    subtitle: `${h.name} · INR`,
    meta: [['Period', period], ['Entries', String(L.total)], ['Currency', 'INR']],
    head: ['Date', 'From account', 'Kind', 'Description', 'Paid in', 'Taken out', 'Balance'],
    numeric: [4, 5, 6], widths: [13, 15, 12, 20, 13, 13, 14],
    opening: ['', '', '', 'Opening balance', '', '', num(L.opening)],
    rows: L.rows.map(r => {
      const d = r.move;
      return [printDate(r.date), r.account || '', r.sub || r.type, r.note || '',
        d > 0 ? num(d) : '', d < 0 ? num(-d) : '', num(r.balance)];
    }),
    closing: ['', '', '', 'Balance', num(L.inSum), num(L.outSum), num(L.closing)],
    standing: `Balance on ${printDate(to || todayISO())}: <b>${money(L.closing, 'INR')}</b>`,
    note: 'Held as a category, not a bank account — “From account” is the bank each payment moved through.',
  });
}

function exportHolding(h, L) {
  const head = ['Date', 'From account', 'Kind', 'Description', 'Paid in', 'Taken out', 'Balance'];
  downloadCSV(`jinnyfin-${h.name.replace(/\W+/g, '-')}-${todayISO()}.csv`,
    [['Holding', h.name], ['Opening', L.opening.toFixed(2)], ['Balance', L.closing.toFixed(2)], [], head,
      ...L.rows.map(r => { const d = r.move;
        return [r.date, r.account || '', r.sub || r.type, r.note || '',
          d > 0 ? d.toFixed(2) : '', d < 0 ? (-d).toFixed(2) : '', r.balance.toFixed(2)]; })]);
}

// ---------------------------------------------------------- one account ----
function drawOne() {
  host.innerHTML = '';
  let from = f.from, to = f.to;
  if (f.year !== 'All') {
    const y = +f.year;
    if (f.month !== 'All') { from = `${y}-${String(f.month).padStart(2, '0')}-01`; to = endOfMonth(y, +f.month); }
    else { from = `${y}-01-01`; to = `${y}-12-31`; }
  }
  const st = C.statement(f.account, { from, to });

  host.append(topbar(st.account,
    el('button', { class: 'btn sm ghost', onclick: () => openThing('') }, '← All accounts'),
    el('button', { class: 'btn sm', onclick: () => printOne(st) }, '🧾 Print / PDF'),
    el('button', { class: 'btn sm', onclick: () => exportCSV(st) }, '⬇ CSV')));

  host.append(periodFilters());

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('Opening balance', money(st.opening, st.currency)),
    kpi('In', money(st.inSum, st.currency), 'income'),
    kpi('Out', money(st.outSum, st.currency), 'expense'),
    kpi('Closing balance', money(st.closing, st.currency), st.closing < 0 ? 'expense' : '')));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, `${st.account} · ${entries(st.rows.length)}`)),
    // A seven-column table on a 360px phone means dragging sideways to read one
    // row. Narrow screens get the same rows as a list instead, each carrying its
    // own running balance — the number you actually came here for.
    el('div', { class: 'stmt-list' }, ...listRows(st)),
    el('div', { class: 'table-wrap stmt-table', style: 'max-height:70vh;overflow:auto' }, tableOf(st))));

  if (!st.rows.length) host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🧾'), el('p', {}, 'No entries in this period.')));
}

// ------------------------------------------------------------ phone layout --
function listRows(st) {
  const out = [];
  const rows = st.rows.slice().reverse();
  let day = null;
  rows.forEach((r, i) => {
    if (r.date !== day) {
      day = r.date;
      const net = rows.filter(x => x.date === day)
        .reduce((n, x) => n + (+x.income || 0) - (+x.expense || 0), 0);
      out.push(el('div', { class: 'tx-day' }, fmtDate(day),
        el('span', { class: net >= 0 ? 'pos' : 'neg' }, money(net, st.currency, false))));
    }
    const isIn = Number(r.income) > 0;
    out.push(el('div', { class: 'tx', onclick: () => openTxEditor(r) },
      el('div', { class: 'av' }, typeIcon(r.type)),
      el('div', { style: 'min-width:0' },
        el('div', { class: 't1' }, r.note || r.sub || r.parent || r.type),
        el('div', { class: 't2' }, [r.parent, r.sub].filter(Boolean).join(' · ') || r.type)),
      el('div', { class: 'amt ' + (isIn ? 'in' : 'out') },
        (isIn ? '+' : '−') + money(isIn ? r.income : r.expense, st.currency),
        // the balance after this entry, the way a bank app shows it
        el('span', { class: 'sub bal' }, '(' + num(r.balance) + ')'))));
  });
  return out;
}

// ----------------------------------------------------------- wide layout --
function tableOf(st) {
  const t = el('table');
  t.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Date'), el('th', {}, 'Type'), el('th', {}, 'Category'), el('th', {}, 'Description'),
    el('th', { class: 'n' }, 'In'), el('th', { class: 'n' }, 'Out'), el('th', { class: 'n' }, 'Balance'))));
  const tb = el('tbody');
  for (const r of st.rows.slice().reverse()) {
    tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openTxEditor(r) },
      el('td', {}, fmtDate(r.date)),
      el('td', {}, typeIcon(r.type) + ' ' + r.type),
      el('td', {}, [r.parent, r.sub].filter(Boolean).join(' · ')),
      el('td', { class: 'wrap' }, r.note || ''),
      el('td', { class: 'n' }, r.income ? num(r.income) : ''),
      el('td', { class: 'n' }, r.expense ? num(r.expense) : ''),
      el('td', { class: 'n ' + (r.balance < 0 ? 'neg' : '') }, num(r.balance))));
  }
  t.append(tb);
  return t;
}

function printOne(st) {
  const period = (f.from || f.to)
    ? `${f.from ? printDate(f.from) : 'the beginning'} — ${f.to ? printDate(f.to) : printDate(todayISO())}`
    : f.year !== 'All' ? (f.month !== 'All' ? `${MONTHS[+f.month - 1]} ${f.year}` : String(f.year))
      : 'All time';
  const cols = ['Date', 'Type', 'Category', 'Description', 'In', 'Out', 'Balance'];
  printStatement({
    title: 'Statement of account',
    subtitle: `${st.account} · ${st.currency}`,
    meta: [['Period', period], ['Entries', String(st.rows.length)], ['Currency', st.currency]],
    head: cols, numeric: [4, 5, 6], widths: [13, 10, 16, 21, 13, 13, 14],
    opening: ['', '', '', 'Opening balance', '', '', num(st.opening)],
    rows: st.rows.map(r => [printDate(r.date), r.type, [r.parent, r.sub].filter(Boolean).join(' · '),
      r.note || '', r.income ? num(r.income) : '', r.expense ? num(r.expense) : '', num(r.balance)]),
    closing: ['', '', '', 'Closing balance', num(st.inSum), num(st.outSum), num(st.closing)],
    standing: `Balance on ${printDate(f.to || todayISO())}: <b>${money(st.closing, st.currency)}</b>`,
    note: '“In” is money that came into this account; “Out” is money that left it. '
        + 'Every line is converted at the rate of the month it happened in.',
  });
}

function exportCSV(st) {
  const head = ['Date', 'Type', 'Category', 'Sub', 'Description', 'In', 'Out', 'Balance'];
  const rows = st.rows.map(r => [r.date, r.type, r.parent || '', r.sub || '', r.note || '',
    r.income || 0, r.expense || 0, r.balance.toFixed(2)]);
  downloadCSV(`jinnyfin-statement-${st.account.replace(/\W+/g, '-')}-${todayISO()}.csv`,
    [['Account', st.account], ['Currency', st.currency], ['Opening', st.opening.toFixed(2)], ['Closing', st.closing.toFixed(2)], [], head, ...rows]);
}
