// ============================================================================
//  calc.js — the finance engine.
//  Every formula here is a 1:1 translation of the ones in MISA Entry 06.xlsm,
//  verified against the workbook to the paisa (see VERIFICATION.md).
// ============================================================================
import { DB, getSettings } from './store.js';
import { iso, monthStart, todayISO, round2, yearOf, monthOf, endOfMonth, daysBetween, MONTHS } from './util.js';

export const TYPES = ['Income', 'Expense', 'Transfer', 'Lend/Borrow', 'Investment', 'Opening Balance'];

// ------------------------------------------------------------------ rates --
export function rates() {
  const s = getSettings();
  return { sar: Number(s.sar_to_inr) || 25.239, usd: Number(s.usd_to_sar) || 3.76 };
}

let _fxCache = null, _fxStamp = null;
function fxMap() {
  const stamp = DB.fx_rates.length + ':' + (DB.fx_rates[DB.fx_rates.length - 1]?.updated_at || '');
  if (_fxCache && _fxStamp === stamp) return _fxCache;
  const m = new Map();
  for (const r of DB.fx_rates) m.set(String(r.month).slice(0, 7), Number(r.rate) || 0);
  _fxCache = m; _fxStamp = stamp;
  return m;
}
/** SAR→INR rate that applied in the month of `date` (falls back to the latest). */
export function fxFor(date) {
  const m = fxMap(), key = iso(date).slice(0, 7);
  if (m.has(key)) return m.get(key);
  const keys = [...m.keys()].sort();
  let best = null;
  for (const k of keys) { if (k <= key) best = k; else break; }
  return best ? m.get(best) : rates().sar;
}

export const inrOf = t => (t.currency === 'SAR' ? Number(t.income || 0) * (t.fx || fxFor(t.date)) : Number(t.income || 0));
export const inrOut = t => (t.currency === 'SAR' ? Number(t.expense || 0) * (t.fx || fxFor(t.date)) : Number(t.expense || 0));
export const sarOf = t => (t.currency === 'SAR' ? Number(t.income || 0) : Number(t.income || 0) / (t.fx || fxFor(t.date)));
export const sarOut = t => (t.currency === 'SAR' ? Number(t.expense || 0) : Number(t.expense || 0) / (t.fx || fxFor(t.date)));

/** Convert a live balance to INR using today's rate (what the sheet does). */
export function liveINR(amount, currency) {
  const r = rates();
  if (currency === 'SAR') return amount * r.sar;
  if (currency === 'USD') return amount * r.usd * r.sar;
  return amount;
}

/**
 * What an amount in one currency is worth in another, at the rate for a given
 * date — the same rate every other figure on that date is converted with, so a
 * transfer entered on an old date is not valued at today's price.
 */
export function convertAmount(amount, from, to, date) {
  const n = Number(amount) || 0;
  if (!n || from === to) return n;
  const fx = fxFor(date);                       // SAR -> INR for that month
  const usd = rates().usd;                      // USD -> SAR
  const toINR = c => (c === 'SAR' ? fx : c === 'USD' ? usd * fx : 1);
  return n * toINR(from) / toINR(to);
}

// ------------------------------------------------------------- structure ---
export const accountsByName = () => new Map(DB.accounts.map(a => [a.name, a]));
export const currencyOf = name => accountsByName().get(name)?.currency || 'SAR';
// ------------------------------------------------------------- liveliness --
export const IDLE_DAYS = 60;

/** The date of the last movement on each account. */
export function lastActivity() {
  const m = new Map();
  for (const t of DB.transactions) {
    if (!t.account) continue;
    const d = iso(t.date);
    if (!m.has(t.account) || m.get(t.account) < d) m.set(t.account, d);
  }
  return m;
}

/**
 * An account is live if money has moved on it in the last 60 days — or if it is
 * younger than that and simply has not been used yet. A brand new account must
 * not vanish the moment it is created; it gets the same 60 days to prove itself.
 * A ticked-off "Active" box in Settings still wins, so a decision can be forced.
 */
export function accountStatus(a, seen = lastActivity(), today = todayISO()) {
  const last = seen.get(a.name) || null;
  const age = last ? daysBetween(last, today) : null;
  const born = a.created_at ? iso(a.created_at) : null;
  const grace = born ? daysBetween(born, today) <= IDLE_DAYS : false;
  // The rule decides. "Always show" is the one manual override, for an account
  // you want in the pickers even while it sits quiet.
  if (a.pinned) return { live: true, last, age, why: 'always shown (your choice)' };
  if (age != null && age <= IDLE_DAYS) return { live: true, last, age, why: `used ${age} day${age === 1 ? '' : 's'} ago` };
  if (grace) return { live: true, last, age, why: 'new — 60 days to get going' };
  return { live: false, last, age,
    why: last ? `nothing for ${age} days` : 'never used, and older than 60 days' };
}

/** Accounts offered in pickers: the live ones, in the order you arranged them. */
export const activeAccounts = () => {
  const seen = lastActivity();
  return DB.accounts.filter(a => accountStatus(a, seen).live);
};
export const accountNames = () => activeAccounts().map(a => a.name);

// ----------------------------------------------------------- holdings -----
/**
 * KSFE, a savings fund, a plot of land — these are not accounts. The money for
 * them leaves a bank account and is tagged with the holding's name as its
 * category, so the holding's history lives in `parent`, not in `account`.
 * This is that history, oldest first, with the balance after each movement.
 */
export function holdingLedger(tag, f = {}) {
  const rows = DB.transactions
    .filter(t => t.parent === tag && (!f.from || t.date >= f.from) && (!f.to || t.date <= f.to))
    .map(t => ({ ...t }));
  const before = f.from ? DB.transactions.filter(t => t.parent === tag && t.date < f.from) : [];
  // The same arithmetic the net-worth screen uses, so the two can never disagree:
  // what you put in counts up, a return counts up, only a withdrawal counts down.
  // (An asset has no returns, so for one of those every payment simply counts up.)
  const isFund = investmentCategories().includes(tag);
  const step = t => (isFund
    ? inrOut(t) + (t.sub === 'Withdrawal' ? -inrOf(t) : inrOf(t))
    : inrOut(t) - inrOf(t));
  // An asset can carry cost from before the ledger began — the land was bought
  // years before the first row was ever typed. Net worth counts that opening
  // cost, so the statement has to as well, or the two screens disagree about
  // the same thing and you cannot tell which one is lying.
  const asset = DB.assets.find(a => (a.category_tag || a.name) === tag);
  const priorCost = asset ? Number(asset.opening_cost || 0) : 0;
  let run = priorCost + before.reduce((n, t) => n + step(t), 0);
  const opening = run;
  let inSum = 0, outSum = 0;
  for (const r of rows) {
    const d = step(r);
    if (d >= 0) inSum += d; else outSum += -d;
    run += d;
    r.balance = round2(run);
    r.move = round2(d);
  }
  return { tag, rows, priorCost: round2(priorCost),
           opening: round2(opening), inSum: round2(inSum),
           outSum: round2(outSum), closing: round2(run), total: rows.length };
}

/** Every holding the app knows about: investment funds and fixed assets. */
export function holdings() {
  const seen = new Set();
  const out = [];
  for (const c of investmentCategories()) {
    if (seen.has(c)) continue; seen.add(c);
    out.push({ tag: c, kind: 'investment', name: c });
  }
  for (const a of DB.assets) {
    const tag = a.category_tag || a.name;
    if (!tag || seen.has(tag)) continue; seen.add(tag);
    out.push({ tag, kind: 'asset', name: a.name, asset: a });
  }
  return out;
}
export const cashAccounts = () => DB.accounts.filter(a => a.grp === 'primary' && a.active !== false);
export const investmentAccounts = () => DB.accounts.filter(a => a.grp === 'investment' && a.active !== false);
export function investmentCategories() {
  const s = getSettings();
  return s.investment_categories ||
    ['KSFE', 'Millionaire Federal Savings', 'PO Savings - Afiya', 'PO Savings - Lamiya'];
}
export const assetCategories = () => DB.assets.filter(a => !a.deleted).map(a => a.category_tag).filter(Boolean);

// -------------------------------------------------------------- filtering --
export function txUpTo(asOf) {
  const d = asOf || todayISO();
  return DB.transactions.filter(t => t.date <= d);
}

/**
 * Generic filter used by every report screen.
 * { from, to, year, month, account, type, parent, sub, payee, text, currency }
 */
export function filterTx(f = {}) {
  const q = (f.text || '').toLowerCase().trim();
  return DB.transactions.filter(t => {
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.year && f.year !== 'All' && yearOf(t.date) !== +f.year) return false;
    if (f.month && f.month !== 'All' && monthOf(t.date) !== +f.month) return false;
    if (f.account && f.account !== 'All' && t.account !== f.account) return false;
    if (f.type && f.type !== 'All' && t.type !== f.type) return false;
    if (f.parent && f.parent !== 'All' && t.parent !== f.parent) return false;
    if (f.sub && f.sub !== 'All' && t.sub !== f.sub) return false;
    if (f.payee && f.payee !== 'All' && t.payee !== f.payee) return false;
    if (f.currency && f.currency !== 'All' && t.currency !== f.currency) return false;
    if (f.event && f.event !== 'All' && t.event !== f.event) return false;
    if (q) {
      const hay = `${t.note || ''} ${t.parent || ''} ${t.sub || ''} ${t.payee || ''} ${t.account || ''} ${t.event || ''} ${t.income || ''}${t.expense || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ============================================================== DASHBOARD ===
/** Dashboard "TOTAL INCOME" / "TOTAL EXPENSES" — historical-rate INR. */
export function periodTotals(f = {}) {
  let incINR = 0, expINR = 0, incSAR = 0, expSAR = 0;
  for (const t of filterTx(f)) {
    if (t.type === 'Income') { incINR += inrOf(t); incSAR += sarOf(t); }
    else if (t.type === 'Expense') { expINR += inrOut(t); expSAR += sarOut(t); }
  }
  return {
    incomeINR: incINR, expenseINR: expINR, netINR: incINR - expINR,
    incomeSAR: incSAR, expenseSAR: expSAR, netSAR: incSAR - expSAR,
    savingsRate: incINR ? (incINR - expINR) / incINR : 0,
  };
}

/** Balance of one account in its own currency, as of a date. */
export function accountBalance(name, asOf) {
  const a = accountsByName().get(name);
  let bal = Number(a?.opening_bal || 0);
  const d = asOf || todayISO();
  for (const t of DB.transactions) {
    if (t.account !== name || t.date > d) continue;
    bal += Number(t.income || 0) - Number(t.expense || 0);
  }
  return bal;
}

export function allAccountBalances(asOf) {
  const d = asOf || todayISO();
  const m = new Map();
  for (const a of DB.accounts) m.set(a.name, Number(a.opening_bal || 0));
  for (const t of DB.transactions) {
    if (t.date > d) continue;
    m.set(t.account, (m.get(t.account) || 0) + Number(t.income || 0) - Number(t.expense || 0));
  }
  return m;
}

/**
 * One pass over the ledger, accumulating everything net worth needs.
 * Doing this once (instead of a scan per component) is what keeps the
 * month-by-month trend chart instant on 25,000 rows.
 */
function accumulate(t, acc) {
  const inc = Number(t.income || 0), exp = Number(t.expense || 0);
  acc.bal.set(t.account, (acc.bal.get(t.account) || 0) + inc - exp);
  if (t.parent) {
    const iv = acc.inv.get(t.parent);
    if (iv) { iv.dep += exp; if (t.sub === 'Withdrawal') iv.wd += inc; else iv.interest += inc; }
    if (acc.assetTags.has(t.parent)) acc.asset.set(t.parent, (acc.asset.get(t.parent) || 0) + inrOut(t) - inrOf(t));
  }
  if (t.type === 'Lend/Borrow' && t.payee) {
    const p = acc.payee.get(t.payee) || { sar: 0, inr: 0, equiv: 0, count: 0 };
    if (t.currency === 'SAR') p.sar += inc - exp; else p.inr += inc - exp;
    p.equiv += inrOf(t) - inrOut(t); p.count++;
    acc.payee.set(t.payee, p);
  }
}
function newAcc() {
  const acc = { bal: new Map(), inv: new Map(), asset: new Map(), payee: new Map(), assetTags: new Set() };
  for (const a of DB.accounts) acc.bal.set(a.name, Number(a.opening_bal || 0));
  for (const c of investmentCategories()) acc.inv.set(c, { dep: 0, interest: 0, wd: 0 });
  for (const a of DB.assets) if (a.category_tag) acc.assetTags.add(a.category_tag);
  return acc;
}
function summarise(acc) {
  const eq = equitySummary();
  let cash = 0;
  for (const a of cashAccounts()) cash += liveINR(acc.bal.get(a.name) || 0, a.currency);

  const detail = [];
  let invTotal = 0;
  for (const a of investmentAccounts()) {
    const v = liveINR(acc.bal.get(a.name) || 0, a.currency);
    detail.push({ name: a.name, value: v, kind: 'account' }); invTotal += v;
  }
  for (const [name, x] of acc.inv) {
    const v = x.dep + x.interest - x.wd;
    detail.push({ name, value: v, kind: 'category', deposits: x.dep, interest: x.interest, withdrawn: x.wd });
    invTotal += v;
  }
  if (eq.marketValue) { detail.push({ name: 'Equity Shares (Geojit)', value: eq.marketValue, kind: 'equity' }); invTotal += eq.marketValue; }

  const assetRows = DB.assets.map(a => {
    const cost = (acc.asset.get(a.category_tag) || 0) + Number(a.opening_cost || 0);
    const mv = Number(a.market_value || 0);
    return { ...a, cost, market: mv, used: mv > 0 ? mv : cost,
      gain: mv > 0 ? mv - cost : 0, gainPct: mv > 0 && cost ? (mv - cost) / cost : 0 };
  });
  const assetTotal = assetRows.reduce((s, r) => s + r.used, 0);

  const rows = [...acc.payee.entries()].map(([payee, p]) => {
    const open = round2(p.sar) !== 0 || round2(p.inr) !== 0;
    const cur = round2(p.sar) !== 0 ? 'SAR' : 'INR';
    const bal = cur === 'SAR' ? round2(p.sar) : round2(p.inr);
    return { payee, ...p, open, currency: cur, balance: bal,
      status: !open ? 'settled' : bal > 0 ? 'i-owe' : 'they-owe' };
  }).sort((a, b) => Math.abs(b.equivINR ?? b.equiv) - Math.abs(a.equivINR ?? a.equiv));
  for (const r of rows) r.equivINR = r.equiv;
  const lbNet = -rows.filter(r => r.open).reduce((s, r) => s + r.equiv, 0);
  const lb = {
    rows, netINR: lbNet,
    iOwe: rows.filter(r => r.status === 'i-owe').reduce((s, r) => s + r.equiv, 0),
    theyOwe: -rows.filter(r => r.status === 'they-owe').reduce((s, r) => s + r.equiv, 0),
    openCount: rows.filter(r => r.open).length,
    settledCount: rows.filter(r => !r.open).length,
  };
  return { cash, investments: invTotal, assets: assetTotal, lendBorrow: lbNet,
    total: cash + invTotal + assetTotal + lbNet,
    parts: { inv: { total: invTotal, detail }, fa: { total: assetTotal, rows: assetRows }, lb } };
}

function snapshot(asOf) {
  const d = asOf || todayISO();
  const acc = newAcc();
  for (const t of DB.transactions) { if (t.date > d) break; accumulate(t, acc); }
  return acc;
}

/** Cash & bank total, converted to INR at today's rate. */
export function cashTotalINR(asOf) { return summarise(snapshot(asOf)).cash; }

/** Investments: accounts (income − expense) + categories (deposits + returns − withdrawals). */
export function investmentsINR(asOf) { return summarise(snapshot(asOf)).parts.inv; }

/** Fixed assets = cumulative spend on the tagged categories + pre-ledger cost. */
export function fixedAssetsINR(asOf) { return summarise(snapshot(asOf)).parts.fa; }

/**
 * Net lend/borrow. Payees settled in BOTH currencies drop out — their
 * historical-rate equivalent is only exchange-rate noise. Negative = you owe.
 */
export function lendBorrowPositions(asOf) { return summarise(snapshot(asOf)).parts.lb; }

export function netWorth(asOf) {
  const d = asOf || todayISO();
  return { asOf: d, ...summarise(snapshot(d)) };
}

/** Month-end net-worth series — one pass over the ledger for the whole chart. */
export function netWorthSeries(fromYear) {
  if (!DB.transactions.length) return [];
  const last = todayISO();
  const first = DB.transactions[0].date;
  let y = yearOf(first), m = monthOf(first);
  if (fromYear && fromYear !== 'All') { y = +fromYear; m = 1; }
  const marks = [];
  while (marks.length < 400) {
    const eom = endOfMonth(y, m);
    if (eom >= last) { marks.push(last); break; }
    marks.push(eom);
    m++; if (m > 12) { m = 1; y++; }
  }
  const acc = newAcc();
  const out = [];
  let i = 0;
  for (const mark of marks) {
    while (i < DB.transactions.length && DB.transactions[i].date <= mark) accumulate(DB.transactions[i++], acc);
    const s = summarise(acc);
    out.push({ month: mark, cash: s.cash, investments: s.investments, assets: s.assets,
      lendBorrow: s.lendBorrow, total: s.total });
  }
  return out;
}

// ------------------------------------------------------- income / expense --
/** Dashboard "INCOME BY SOURCE" / "EXPENSE BY SOURCE". */
export function bySource(kind, f = {}) {
  const isIncome = kind === 'Income';
  const m = new Map();
  for (const t of filterTx({ ...f, type: kind })) {
    const key = t.parent || '(none)';
    const r = m.get(key) || { name: key, sar: 0, inr: 0, equiv: 0, count: 0 };
    if (isIncome) {
      if (t.currency === 'SAR') r.sar += Number(t.income || 0); else r.inr += Number(t.income || 0);
      r.equiv += inrOf(t);
    } else {
      if (t.currency === 'SAR') r.sar += Number(t.expense || 0); else r.inr += Number(t.expense || 0);
      r.equiv += inrOut(t);
    }
    r.count++;
    m.set(key, r);
  }
  return [...m.values()].sort((a, b) => b.equiv - a.equiv);
}

/** Sub-category breakdown inside one parent. */
export function bySub(kind, parent, f = {}) {
  const isIncome = kind === 'Income';
  const m = new Map();
  for (const t of filterTx({ ...f, type: kind, parent })) {
    const key = t.sub || '(no sub-category)';
    const r = m.get(key) || { name: key, sar: 0, inr: 0, equiv: 0, count: 0 };
    if (isIncome) { if (t.currency === 'SAR') r.sar += +t.income || 0; else r.inr += +t.income || 0; r.equiv += inrOf(t); }
    else { if (t.currency === 'SAR') r.sar += +t.expense || 0; else r.inr += +t.expense || 0; r.equiv += inrOut(t); }
    r.count++; m.set(key, r);
  }
  return [...m.values()].sort((a, b) => b.equiv - a.equiv);
}

/** 12 monthly totals for one year (Expense Report / Income Report). */
export function monthlyTotals(kind, year, f = {}) {
  const rows = MONTHS.map((name, i) => ({ month: name, mno: i + 1, sar: 0, inr: 0, equiv: 0 }));
  for (const t of filterTx({ ...f, type: kind, year })) {
    const r = rows[monthOf(t.date) - 1];
    if (kind === 'Income') { if (t.currency === 'SAR') r.sar += +t.income || 0; else r.inr += +t.income || 0; r.equiv += inrOf(t); }
    else { if (t.currency === 'SAR') r.sar += +t.expense || 0; else r.inr += +t.expense || 0; r.equiv += inrOut(t); }
  }
  return rows;
}

/** One row per year (all years). */
export function yearlyTotals(kind, f = {}) {
  const m = new Map();
  for (const t of filterTx({ ...f, type: kind })) {
    const y = yearOf(t.date);
    const r = m.get(y) || { year: y, sar: 0, inr: 0, equiv: 0 };
    if (kind === 'Income') { if (t.currency === 'SAR') r.sar += +t.income || 0; else r.inr += +t.income || 0; r.equiv += inrOf(t); }
    else { if (t.currency === 'SAR') r.sar += +t.expense || 0; else r.inr += +t.expense || 0; r.equiv += inrOut(t); }
    m.set(y, r);
  }
  return [...m.values()].sort((a, b) => a.year - b.year);
}

/** Income vs Expense, grouped and sorted. */
export function incomeVsExpense(f = {}, groupBy = 'parent') {
  const m = new Map();
  let ti = { sar: 0, inr: 0, equiv: 0 }, te = { sar: 0, inr: 0, equiv: 0 };
  for (const t of filterTx(f)) {
    if (t.type !== 'Income' && t.type !== 'Expense') continue;
    const key = (groupBy === 'sub' ? (t.sub || t.parent) : groupBy === 'account' ? t.account : t.parent) || '(none)';
    const r = m.get(key) || { name: key, incSAR: 0, incINR: 0, expSAR: 0, expINR: 0, equiv: 0 };
    if (t.type === 'Income') {
      if (t.currency === 'SAR') { r.incSAR += +t.income || 0; ti.sar += +t.income || 0; } else { r.incINR += +t.income || 0; ti.inr += +t.income || 0; }
      r.equiv += inrOf(t); ti.equiv += inrOf(t);
    } else {
      if (t.currency === 'SAR') { r.expSAR += +t.expense || 0; te.sar += +t.expense || 0; } else { r.expINR += +t.expense || 0; te.inr += +t.expense || 0; }
      r.equiv += inrOut(t); te.equiv += inrOut(t);
    }
    m.set(key, r);
  }
  return { rows: [...m.values()].sort((a, b) => b.equiv - a.equiv), income: ti, expense: te, net: ti.equiv - te.equiv };
}

// ------------------------------------------------------------- statement ---
/** Account statement with a running balance, opening + closing. */
export function statement(account, f = {}) {
  const all = DB.transactions.filter(t => t.account === account);
  const from = f.from || null, to = f.to || null;
  let opening = Number(accountsByName().get(account)?.opening_bal || 0);
  const rows = [];
  let run = opening;
  for (const t of all) {
    const before = from && t.date < from;
    const after = to && t.date > to;
    if (before) { opening += (+t.income || 0) - (+t.expense || 0); run = opening; continue; }
    if (after) continue;
    run += (+t.income || 0) - (+t.expense || 0);
    rows.push({ ...t, balance: run });
  }
  const inSum = rows.reduce((s, r) => s + (+r.income || 0), 0);
  const outSum = rows.reduce((s, r) => s + (+r.expense || 0), 0);
  return { account, currency: currencyOf(account), opening, closing: run, rows, inSum, outSum, net: inSum - outSum };
}

/** Ledger for one payee, with a running balance (positive = you owe them). */
export function payeeLedger(payee) {
  const rows = DB.transactions
    .filter(t => t.type === 'Lend/Borrow' && t.payee === payee)
    .map(t => ({ ...t }));
  let run = 0;
  for (const r of rows) { run += (+r.income || 0) - (+r.expense || 0); r.balance = run; }
  return rows;
}

// -------------------------------------------------------------- business ---
export function businessPL(biz, f = {}) {
  const match = (t, parent, sub) => parent && t.parent === parent && (!sub || t.sub === sub);
  const rows = filterTx(f).filter(t =>
    (t.type === 'Income' && match(t, biz.income_parent, biz.income_sub)) ||
    (t.type === 'Expense' && match(t, biz.expense_parent, biz.expense_sub)));
  const inc = { sar: 0, inr: 0, equiv: 0 }, exp = { sar: 0, inr: 0, equiv: 0 };
  const byYear = new Map();
  for (const t of rows) {
    const y = yearOf(t.date);
    const yr = byYear.get(y) || { year: y, income: 0, expense: 0 };
    if (t.type === 'Income') {
      if (t.currency === 'SAR') inc.sar += +t.income || 0; else inc.inr += +t.income || 0;
      inc.equiv += inrOf(t); yr.income += inrOf(t);
    } else {
      if (t.currency === 'SAR') exp.sar += +t.expense || 0; else exp.inr += +t.expense || 0;
      exp.equiv += inrOut(t); yr.expense += inrOut(t);
    }
    byYear.set(y, yr);
  }
  return {
    rows, income: inc, expense: exp, netEquiv: inc.equiv - exp.equiv,
    byYear: [...byYear.values()].map(y => ({ ...y, net: y.income - y.expense })).sort((a, b) => a.year - b.year),
  };
}

// ---------------------------------------------------------------- equity ---
export function equitySummary() {
  const open = DB.equity_positions.filter(p => !p.closed);
  const closed = DB.equity_positions.filter(p => p.closed);
  const qty = open.reduce((s, p) => s + (+p.qty || 0), 0);
  const invested = open.reduce((s, p) => s + (+p.qty || 0) * (+p.avg_cost || 0), 0);
  const marketValue = open.reduce((s, p) => s + (+p.qty || 0) * (+p.price || 0), 0);
  const realised = closed.reduce((s, p) => s + (+p.realised || 0), 0);
  // Dividends and charges come from the cash book, not the per-scrip column —
  // that is what the workbook's reconciliation block does.
  const dividends = DB.transactions
    .filter(t => t.parent === 'Share Trading' && t.sub === 'Dividend')
    .reduce((s, t) => s + inrOf(t), 0);
  const charges = DB.transactions
    .filter(t => t.parent === 'Share Trading' && t.sub === 'Charges & Taxes')
    .reduce((s, t) => s + inrOut(t), 0);
  return {
    qty, invested, marketValue, unrealised: marketValue - invested,
    unrealisedPct: invested ? (marketValue - invested) / invested : 0,
    realised, dividends, charges,
    netReturn: (marketValue - invested) + realised + dividends - charges,
    open, closed,
  };
}

// ------------------------------------------------------------- insurance ---
export function insuranceAlerts(refDate) {
  const today = refDate || todayISO();
  return DB.insurance
    .map(p => ({ ...p, daysLeft: daysBetween(today, iso(p.renewal_date)) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map(p => ({
      ...p,
      level: p.daysLeft < 0 ? 'expired'
        : p.daysLeft <= 7 ? 'critical'
        : p.daysLeft <= (p.notify_days || 30) ? 'soon' : 'ok',
    }));
}
export function insuranceHeadline(refDate) {
  const a = insuranceAlerts(refDate);
  if (!a.length) return { text: 'No policies added yet', level: 'none', next: null, then: null };
  const exp = a.filter(p => p.level === 'expired');
  const next = a.find(p => p.daysLeft >= 0);
  const then = a.filter(p => p.daysLeft >= 0)[1] || null;
  if (exp.length) return { text: `EXPIRED: ${exp[0].label} ${-exp[0].daysLeft} days ago`, level: 'expired', next, then };
  if (next && next.daysLeft <= (next.notify_days || 30))
    return { text: `RENEW SOON: ${next.label} in ${next.daysLeft} days`, level: 'soon', next, then };
  return { text: 'All insurance active', level: 'ok', next, then };
}

// --------------------------------------------------------------- budgets ---
export function budgetStatus(year, month) {
  const out = [];
  for (const b of DB.budgets) {
    const f = { type: 'Expense', parent: b.parent, year, month: b.period === 'yearly' ? 'All' : month };
    if (b.sub) f.sub = b.sub;
    const spent = filterTx(f).reduce((s, t) => s + inrOut(t), 0);
    const limit = b.currency === 'SAR' ? Number(b.amount) * rates().sar : Number(b.amount);
    out.push({ ...b, spent, limit, pct: limit ? spent / limit : 0, left: limit - spent });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// ----------------------------------------------------------------- lists ---
export const yearsPresent = () =>
  [...new Set(DB.transactions.map(t => yearOf(t.date)))].sort((a, b) => b - a);

export function parentsFor(type) {
  const set = new Set(DB.categories.filter(c => !type || c.type === type).map(c => c.parent));
  return [...set].sort((a, b) => a.localeCompare(b));
}
export function subsFor(type, parent) {
  const set = new Set(DB.categories
    .filter(c => (!type || c.type === type) && c.parent === parent && c.sub)
    .map(c => c.sub));
  return [...set].sort((a, b) => a.localeCompare(b));
}
export const payeeNames = () =>
  [...new Set([...DB.payees.map(p => p.name), ...DB.transactions.map(t => t.payee).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b));
export const eventNames = () =>
  [...new Set(DB.transactions.map(t => t.event).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Reconciliation: app balance vs a figure you typed in from the bank/app. */
export function reconciliation(asOf = null) {
  const bals = allAccountBalances(asOf);
  return DB.accounts.filter(a => a.active !== false).map(a => {
    const app = bals.get(a.name) || 0;
    const stated = a.stated_balance;
    return {
      id: a.id, name: a.name, currency: a.currency, group: a.grp, computed: app,
      stated: stated == null ? null : Number(stated),
      checked: a.reconciled_at || null,
      diff: stated == null ? null : round2(app - Number(stated)),
    };
  });
}
