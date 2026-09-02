// ============================================================================
//  editor.js — add / edit a transaction (shared by every screen).
// ============================================================================
import { el, modal, toast, todayISO, uuid, evalAmount, confirmBox, money, round2 } from '../util.js';
import { DB, put, remove } from '../store.js';
import { fxFor, currencyOf, convertAmount, parentsFor, subsFor, payeeNames, eventNames,
  activeAccounts as liveAccounts } from '../calc.js';

const TYPES = ['Expense', 'Income', 'Transfer', 'Lend/Borrow', 'Investment'];
const ICON = { Expense: '💸', Income: '💵', Transfer: '🔄', 'Lend/Borrow': '🤝', Investment: '📈', 'Opening Balance': '🏁' };
export const typeIcon = t => ICON[t] || '•';

// ── the two types whose categories are a closed set ────────────────────────
// Free text there only invites typos, and a wrong sub-category silently flips
// the direction of the money — so these are dropdowns with fixed choices.
export const LB_SUBS = { Borrow: ['Borrow', 'Repayment'], Lend: ['Lend', 'Collecting debts'] };

const SAVINGS_SUBS = ['Deposit', 'Interest/Return', 'Withdrawal'];
const TRADING_SUBS = ['Buy', 'Sell', 'Charges & Taxes', 'Funding In', 'Funding Out'];
export const investmentSubs = holding => (holding === 'Share Trading' ? TRADING_SUBS : SAVINGS_SUBS);

/** Sub-categories that bring money INTO the account. Everything else takes it out. */
const INFLOW = new Set(['Borrow', 'Collecting debts', 'Interest/Return', 'Withdrawal', 'Sell', 'Funding In']);

/** Holdings you can invest in — from your own category list, so it grows with you. */
const holdings = () => {
  const seen = new Set(DB.categories.filter(c => c.type === 'Investment').map(c => c.parent));
  for (const t of DB.transactions) if (t.type === 'Investment' && t.parent) seen.add(t.parent);
  return [...seen].filter(Boolean).sort((a, b) => a.localeCompare(b));
};

const byGroup = (a, b) => (a.grp === b.grp ? a.name.localeCompare(b.name) : a.grp === 'primary' ? -1 : 1);
/** The same 60-day rule the rest of the app uses — not the stale flag the
 *  workbook import brought with it. */
const activeAccounts = () => liveAccounts().slice().sort(byGroup);
const everyAccount = () => DB.accounts.filter(a => !a.deleted).slice().sort(byGroup);

// ── what may live in an amount box ─────────────────────────────────────────
// Digits, one dot per number, and the four operators. Nothing else — no commas,
// no letters, no spaces, however they arrive (typed, tapped or pasted). An
// operator typed straight after another REPLACES it: 12 + then − reads 12 −,
// because that is what a person means when they change their mind mid-sum.
const oneDot = seg => {
  const i = seg.indexOf('.');
  return i < 0 ? seg : seg.slice(0, i + 1) + seg.slice(i + 1).replace(/\./g, '');
};
export function sanitizeAmount(raw) {
  let s = String(raw ?? '').replace(/[^0-9.+\-*/]/g, '');
  s = s.replace(/[+\-*/]{2,}/g, m => m.slice(-1));   // the last operator wins
  s = s.replace(/^[+*/]+/, '');                      // only a minus may lead
  return s.split(/([+\-*/])/).map(p => (/^[+\-*/]$/.test(p) ? p : oneDot(p))).join('');
}

/** The account you used last — a much better default than whatever sorts first. */
function lastUsedAccount() {
  for (let i = DB.transactions.length - 1; i >= Math.max(0, DB.transactions.length - 50); i--) {
    const n = DB.transactions[i].account;
    if (DB.accounts.some(a => a.name === n && a.active !== false)) return n;
  }
  return activeAccounts()[0]?.name || '';
}

function datalist(id, values) {
  const dl = el('datalist', { id });
  for (const v of values) dl.append(el('option', { value: v }));
  return dl;
}
const fillSelect = (sel, values, keep) => {
  sel.innerHTML = '';
  for (const v of values) sel.append(el('option', { value: v }, v));
  sel.value = values.includes(keep) ? keep : (values[0] || '');
};

export function openTxEditor(existing = null, presets = {}) {
  const isNew = !existing;
  const t = existing ? { ...existing } : {
    id: uuid(), date: todayISO(), time: new Date().toTimeString().slice(0, 5),
    type: 'Expense', account: presets.account || lastUsedAccount(),
    currency: 'SAR', income: 0, expense: 0, parent: '', sub: '', payee: '', event: '', note: '',
    ...presets,
  };
  let type = t.type;

  const body = el('div', { class: 'grid', style: 'gap:12px' });
  const typeRow = el('div', { class: 'type-pick' });
  const form = el('div', { class: 'form-grid' });
  body.append(typeRow, form);

  const dateIn = el('input', { type: 'date', value: t.date });
  const timeIn = el('input', { type: 'time', value: t.time || '' });
  // ── amount boxes ─────────────────────────────────────────────────────────
  // One keypad, one or two boxes. A cross-currency transfer grows a second box
  // for what actually landed; the keys always work on whichever box you last
  // touched, so there is never a question of where a digit is going.
  let live = null;                                    // the box the keys act on
  const boxes = [];

  function amountBox(startValue) {
    const input = el('input', { class: 'amount-in', inputmode: 'decimal', placeholder: '0.00',
      value: String(startValue) });
    const box = { input, touched: false };

    /** Clean the text and put the caret back roughly where the person left it. */
    const scrub = () => {
      const raw = input.value;
      const at = input.selectionStart ?? raw.length;
      const clean = sanitizeAmount(raw);
      if (clean === raw) return;
      const head = sanitizeAmount(raw.slice(0, at)).length;
      input.value = clean;
      const p = Math.min(head, clean.length);
      try { input.setSelectionRange(p, p); } catch { /* not focused */ }
    };

    box.insert = ch => {
      // Read the caret BEFORE focusing: a field that lost focus reports 0, and
      // the key would edit the front of the number instead of the end.
      const len = input.value.length;
      const on = document.activeElement === input;
      const a = on ? (input.selectionStart ?? len) : len;
      const b = on ? (input.selectionEnd ?? a) : a;
      input.focus();
      if (ch === '⌫') {
        const from = a === b ? Math.max(0, a - 1) : a;
        input.value = input.value.slice(0, from) + input.value.slice(b);
        try { input.setSelectionRange(from, from); } catch { /* not focused */ }
      } else {
        input.value = input.value.slice(0, a) + ch + input.value.slice(b);
        try { input.setSelectionRange(a + ch.length, a + ch.length); } catch { /* not focused */ }
      }
      scrub();
      box.touched = true;
      showCalc(); onAmountChanged(box);
    };

    box.settle = () => {
      scrub();
      if (!input.value.trim()) { input.value = '0'; showCalc(); onAmountChanged(box); return; }
      const v = evalAmount(input.value);
      if (!Number.isNaN(v) && /[+\-*/]/.test(input.value.trim().slice(1))) input.value = String(round2(v));
      showCalc(); onAmountChanged(box);
    };
    box.value = () => round2(evalAmount(input.value));
    box.set = v => { input.value = String(round2(v)); box.touched = false; };

    // The opening 0 is a starting point, not something to delete: the first
    // digit replaces it, but "0." and "0+..." keep it.
    input.addEventListener('beforeinput', e => {
      if (input.value === '0' && e.data && /[0-9]/.test(e.data) &&
          input.selectionStart === input.value.length) input.value = '';
    });
    input.addEventListener('focus', () => { live = box; if (input.value === '0') input.select(); });
    input.addEventListener('input', () => { scrub(); box.touched = true; showCalc(); onAmountChanged(box); });
    input.addEventListener('paste', () => setTimeout(scrub, 0));
    input.addEventListener('blur', () => {
      if (keyPress) { keyPress = false; setTimeout(() => input.focus(), 0); return; }
      box.settle();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); box.settle(); } });
    boxes.push(box);
    return box;
  }

  const calcOut = el('span', { class: 'calc-out' });
  const showCalc = () => {
    const raw = (live || boxes[0]).input.value.trim();
    const sum = /[+\-*/]/.test(raw.slice(1));         // a leading minus is a sign, not a sum
    const v = evalAmount(raw);
    calcOut.className = 'calc-out' + (sum ? ' on' : '') + (Number.isNaN(v) ? ' bad' : '');
    calcOut.textContent = !sum ? '' : Number.isNaN(v) ? 'not a sum' : '= ' + round2(v).toFixed(2);
  };

  // Tapping one of our own keys must not count as "left the field" - but on a
  // touch screen the focus change cannot be cancelled without also cancelling
  // the tap. So a key raises a flag on the way down; the blur that follows sees
  // it, hands focus straight back, and lowers it again. Any later blur is real.
  let keyPress = false;
  const claim = () => { keyPress = true; };
  const key = (label, run, cls = '') => el('button', {
    type: 'button', class: 'calc-key' + cls,
    onpointerdown: claim, ontouchstart: claim, onmousedown: claim,
    onclick: e => { e.preventDefault(); keyPress = false; run(); },
  }, label);
  const calcKeys = el('div', { class: 'calc-keys' },
    ...[['+', '+'], ['−', '-'], ['×', '*'], ['÷', '/']]
      .map(([label, ch]) => key(label, () => (live || boxes[0]).insert(ch))),
    key('⌫', () => (live || boxes[0]).insert('⌫'), ' del'),
    key('=', () => (live || boxes[0]).settle(), ' eq'),
    calcOut);

  const amountBoxA = amountBox(Number(t.income) || Number(t.expense) || 0);
  const amountIn = amountBoxA.input;
  live = amountBoxA;

  // The second box exists only for a transfer between two currencies.
  const amountBoxB = amountBox(0);
  const landedHint = el('div', { class: 'hint' });
  const landedField = el('div', { class: 'field full', style: 'display:none' },
    el('label', {}, 'Landed as'), amountBoxB.input, landedHint);

  const acctSel = el('select', {});
  const toSel = el('select', {});
  // Currency is the account's own, never a separate choice: picking INR on a
  // riyal account silently valued the row twenty-five times wrong.
  const curSel = el('input', { readonly: true, tabindex: '-1', class: 'locked', value: t.currency || 'SAR' });
  const parentIn = el('input', { list: 'dl-parent', value: t.parent || '', placeholder: 'Category' });
  const subIn = el('input', { list: 'dl-sub', value: t.sub || '', placeholder: 'Sub-category (optional)' });
  const payeeIn = el('input', { list: 'dl-payee', value: t.payee || '', placeholder: 'Who?' });
  const eventIn = el('input', { list: 'dl-event', value: t.event || '', placeholder: 'Tag / event (optional)' });
  const noteIn = el('input', { value: t.note || '', placeholder: 'Description' });
  const fxNote = el('div', { class: 'hint' });

  // Fixed-choice category pickers, kept in step with parentIn / subIn so that
  // save() never has to care which control the value came from.
  const catSel = el('select', {});
  const subSel = el('select', {});
  function choicesFor(kind) {
    return kind === 'Lend/Borrow' ? Object.keys(LB_SUBS) : holdings();
  }
  function syncFixed(keepSub) {
    const list = choicesFor(type);
    fillSelect(catSel, list, parentIn.value);
    parentIn.value = catSel.value;
    const subs = type === 'Lend/Borrow' ? (LB_SUBS[catSel.value] || []) : investmentSubs(catSel.value);
    fillSelect(subSel, subs, keepSub ?? subIn.value);
    subIn.value = subSel.value;
    paintAmount();
  }
  catSel.addEventListener('change', () => { parentIn.value = catSel.value; syncFixed(null); });
  subSel.addEventListener('change', () => { subIn.value = subSel.value; paintAmount(); });

  /** Colour the amount by direction — no words needed. */
  function paintAmount() {
    const inflow = type === 'Income'
      || ((type === 'Lend/Borrow' || type === 'Investment') && INFLOW.has(subIn.value));
    amountIn.style.color = type === 'Transfer' ? '' : (inflow ? 'var(--income)' : 'var(--expense)');
  }

  // ── the other side of a transfer ─────────────────────────────────────────
  // A transfer is two rows sharing a group. Rows imported from the workbook
  // were never linked, so for those the app does NOT guess where the money
  // went — guessing is how a re-save used to fling money at a random account.
  const UNKNOWN = '— not known —';
  const pair = t.transfer_group
    ? DB.transactions.filter(x => x.transfer_group === t.transfer_group && !x.deleted)
    : [];
  const outLeg = pair.find(x => +x.expense > 0) || (+t.expense > 0 ? t : null);
  const inLeg = pair.find(x => +x.income > 0) || (+t.income > 0 ? t : null);
  const linked = !!(outLeg && inLeg && outLeg.id !== inLeg.id);
  const rowIsIn = !linked && +t.income > 0;          // an unlinked receiving row
  // A saved transfer already knows what landed. Show that figure, not a fresh
  // conversion — the bank's rate on the day was whatever it was.
  if (linked && +inLeg.income) { amountBoxB.set(inLeg.income); amountBoxB.touched = true; }

  // Idle accounts are out of the way by default, but one tick brings them all
  // back — which is how you give an old unlinked transfer its real other side.
  let showIdle = false;
  const idleTick = el('input', { type: 'checkbox' });
  idleTick.addEventListener('change', () => {
    showIdle = idleTick.checked;
    fillAccounts();
    syncCurrency();
  });
  const idleRow = el('label', { class: 'field full row switch-row', style: 'cursor:pointer;margin-top:-4px' },
    idleTick,
    el('div', { style: 'min-width:0' }, el('span', { class: 'small' }, 'View inactive accounts'),
      el('div', { class: 'hint' }, 'Accounts with nothing on them for 60 days are hidden until you ask.')));

  const fillAccounts = () => {
    // Idle accounts are out of the list — except the one this very entry
    // already uses, or opening an old row would silently move its money.
    const list = showIdle ? everyAccount() : activeAccounts();
    // Both ends of this entry must be in the list even if the account is
    // switched off, or opening an old row would quietly drop the account it
    // names — and saving would then send the money somewhere else.
    const extras = [];
    for (const n of [t.account, outLeg?.account, inLeg?.account]) {
      if (!n || list.some(a => a.name === n) || extras.some(a => a.name === n)) continue;
      const a = DB.accounts.find(x => x.name === n);
      if (a) extras.push(a);
    }
    const options = [...extras, ...list];
    const live = new Set(activeAccounts().map(a => a.name));
    const fillOne = (sel, allowUnknown) => {
      const keep = sel.value;
      sel.innerHTML = '';
      if (allowUnknown) sel.append(el('option', { value: UNKNOWN }, UNKNOWN));
      for (const a of options) {
        const idle = !live.has(a.name);
        sel.append(el('option', { value: a.name },
          `${a.name} · ${a.currency}` + (idle ? ' (idle)' : '')));
      }
      sel.value = keep || '';
    };
    const gap = type === 'Transfer' && !linked && !isNew;
    fillOne(acctSel, gap && rowIsIn);
    fillOne(toSel, gap && !rowIsIn);

    if (type === 'Transfer' && linked) {
      acctSel.value = outLeg.account;
      toSel.value = inLeg.account;
    } else if (gap) {
      // Only the side this row actually records is known.
      acctSel.value = rowIsIn ? UNKNOWN : t.account;
      toSel.value = rowIsIn ? t.account : UNKNOWN;
    } else {
      acctSel.value = t.account || options[0]?.name || '';
      if (isNew || type !== 'Transfer')
        toSel.value = options.find(a => a.name !== acctSel.value)?.name || '';
    }
  };
  fillAccounts();

  /** The currency of whichever account this row's money leaves or enters. */
  const syncCurrency = () => {
    const own = acctSel.value === UNKNOWN ? toSel.value : acctSel.value;
    const c = currencyOf(own);
    if (c) curSel.value = c;
    refreshLanded();
    updateFx();
  };

  /**
   * Two currencies means two amounts: what left, and what landed. The second
   * box is filled at the rate for THIS entry's date — the same rate every other
   * figure on that date uses — and stays yours to retype.
   */
  function refreshLanded() {
    const fromCur = currencyOf(acctSel.value === UNKNOWN ? toSel.value : acctSel.value);
    const toCur = currencyOf(toSel.value === UNKNOWN ? acctSel.value : toSel.value);
    const cross = type === 'Transfer' && acctSel.value !== UNKNOWN && toSel.value !== UNKNOWN
      && fromCur !== toCur;
    landedField.style.display = cross ? '' : 'none';
    if (!cross) return;
    landedField.querySelector('label').textContent = `Landed in ${toSel.value} (${toCur})`;
    if (!amountBoxB.touched) amountBoxB.set(convertAmount(amountBoxA.value(), fromCur, toCur, dateIn.value));
    const one = convertAmount(1, fromCur, toCur, dateIn.value);
    landedHint.textContent = `Rate for ${dateIn.value.slice(0, 7)}: 1 ${fromCur} = ${one.toFixed(4)} ${toCur}`
      + ' · change the amount if the bank gave you something else';
  }

  /**
   * Anything that changes an amount keeps the rest honest. Changing what LEFT
   * is a deliberate change to the transfer, so the landed figure is worked out
   * again; typing in the landed box itself always wins until then.
   */
  function onAmountChanged(box) {
    if (box === amountBoxA) { amountBoxB.touched = false; refreshLanded(); }
    updateFx();
  }

  const updateFx = () => {
    const r = fxFor(dateIn.value);
    const amt = evalAmount(amountIn.value) || 0;
    fxNote.textContent = curSel.value === 'SAR'
      ? `Rate for ${dateIn.value.slice(0, 7)}: 1 SAR = ${r.toFixed(4)} INR  →  ≈ ${money(amt * r, 'INR')}`
      : curSel.value === 'INR' ? `Rate for ${dateIn.value.slice(0, 7)}: 1 SAR = ${r.toFixed(4)} INR` : '';
  };
  acctSel.addEventListener('change', syncCurrency);
  toSel.addEventListener('change', () => { amountBoxB.touched = false; refreshLanded(); });
  dateIn.addEventListener('change', () => { amountBoxB.touched = false; refreshLanded(); updateFx(); });

  function refreshLists() {
    const catType = type === 'Transfer' ? null : type;
    for (const id of ['dl-parent', 'dl-sub', 'dl-payee', 'dl-event']) body.querySelector('#' + id)?.remove();
    body.append(datalist('dl-parent', parentsFor(catType)));
    body.append(datalist('dl-sub', subsFor(catType, parentIn.value)));
    body.append(datalist('dl-payee', payeeNames()));
    body.append(datalist('dl-event', eventNames()));
  }
  parentIn.addEventListener('input', refreshLists);

  function layout() {
    form.innerHTML = '';
    const add = (label, node, cls = '', extra = null) =>
      form.append(el('div', { class: 'field ' + cls }, el('label', {}, label), node, extra));
    add('Amount', amountIn, 'full');
    form.append(landedField);                 // only visible when two currencies meet
    form.append(el('div', { class: 'full' }, calcKeys));
    if (type === 'Transfer') { add('From account', acctSel); add('To account', toSel); }
    else { add('Account', acctSel); add('Currency', curSel); }
    form.append(idleRow);            // every type gets the same escape hatch
    add('Date', dateIn); add('Time', timeIn);

    if (type === 'Lend/Borrow' || type === 'Investment') {
      syncFixed(t.sub);
      add(type === 'Investment' ? 'Holding' : 'Category', catSel);
      add(type === 'Investment' ? 'Action' : 'Sub-category', subSel);
    } else if (type !== 'Transfer') {
      add('Category', parentIn);
      add('Sub-category', subIn);
    }

    if (type === 'Lend/Borrow') add('Payee', payeeIn, 'full');
    else {
      add('Payee / tag', payeeIn);
      add('Event', eventIn);
    }
    add('Description', noteIn, 'full');
    if (type === 'Transfer' && !linked && !isNew) {
      form.append(el('div', { class: 'full alert soon' }, el('span', { class: 'ico' }, '🔗'),
        el('div', {}, 'This transfer was brought in from the workbook and is not tied to its other half. '
          + `Pick the ${rowIsIn ? 'account it came from' : 'account it went to'} and Jinnyfin will find that entry and link the two. `
          + 'Leave it as “not known” and only this row is saved.')));
    }
    form.append(el('div', { class: 'full' }, fxNote));
    refreshLists();
    syncCurrency();
    paintAmount();
  }

  for (const ty of TYPES) {
    const b = el('button', { class: type === ty ? 'on' : '', onclick: () => {
      if (type === ty) return;
      type = ty;
      [...typeRow.children].forEach(c => c.classList.toggle('on', c.dataset.ty === ty));
      // A category belongs to its type. Carrying it across is how you end up
      // filing an investment under "Borrow".
      if (!existing || existing.type !== ty) { parentIn.value = ''; subIn.value = ''; }
      layout();
    }, dataset: { ty } },
      el('span', { class: 'ti' }, ICON[ty]),
      el('span', { class: 'tl' }, { 'Lend/Borrow': 'Lend', Investment: 'Invest' }[ty] || ty));
    typeRow.append(b);
  }
  layout();
  syncCurrency();

  // -------------------------------------------------------------- save ----
  async function save(andAnother = false) {
    const amt = amountBoxA.value();
    if (!isFinite(amt) || amt === 0) { toast('Enter an amount', 'warn'); amountIn.focus(); return; }
    if (!acctSel.value) { toast('Pick an account', 'warn'); return; }
    const fx = fxFor(dateIn.value);
    const base = {
      date: dateIn.value, time: timeIn.value || null, account: acctSel.value,
      currency: curSel.value, parent: parentIn.value.trim() || null, sub: subIn.value.trim() || null,
      payee: payeeIn.value.trim() || null, event: eventIn.value.trim() || null,
      note: noteIn.value.trim() || null, fx,
    };

    if (type === 'Transfer') {
      const from = acctSel.value, to = toSel.value;
      const known = from !== UNKNOWN && to !== UNKNOWN;
      if (known && from === to) { toast('From and To must differ', 'warn'); return; }

      // An older row whose other half was never linked: save it alone, exactly
      // as it stands. Nothing is invented, nothing is doubled.
      if (!known) {
        await put('transactions', { ...base, id: t.id, type: 'Transfer',
          account: rowIsIn ? to : from,
          currency: currencyOf(rowIsIn ? to : from),
          income: rowIsIn ? amt : 0, expense: rowIsIn ? 0 : amt,
          transfer_group: t.transfer_group || null, to_account: t.to_account || null,
          parent: rowIsIn ? base.parent : 'Transfer', no: t.no ?? null });
        toast('Saved this side only — the other half is still unlinked', 'warn', 5000);
        if (andAnother) { reset(); return; }
        m.close(); return;
      }

      const outCur = currencyOf(from), inCur = currencyOf(to);
      const inAmt = outCur === inCur ? amt : amountBoxB.value();
      if (!isFinite(inAmt) || inAmt === 0) {
        toast(`Enter what landed in ${to}`, 'warn'); landedField.querySelector('input').focus(); return;
      }

      let outRow = linked ? outLeg : (rowIsIn ? null : t);
      let inRow = linked ? inLeg : (rowIsIn ? t : null);

      // Not linked, but he has now named the other side. Look for the entry
      // that must already be sitting in the ledger and tie the two together —
      // writing a fresh row instead is what used to double the money.
      if (!linked) {
        const want = rowIsIn ? 'out' : 'in';
        const cand = DB.transactions.filter(x => x.id !== t.id && !x.deleted
          && x.type === 'Transfer' && x.date === base.date && !x.transfer_group
          && x.account === (rowIsIn ? from : to)
          && (want === 'in' ? +x.income > 0 : +x.expense > 0));
        const near = cand.find(x => Math.abs((want === 'in' ? +x.income : +x.expense) - (want === 'in' ? inAmt : amt)) < 0.02)
          || (cand.length === 1 ? cand[0] : null);
        if (near) { if (want === 'in') inRow = near; else outRow = near; }
        else {
          const other = rowIsIn ? from : to;
          if (!(await confirmBox(
            `No matching entry was found on ${other} for ${base.date}. Create the other half of this transfer there?`,
            'Create it'))) return;
        }
      }

      const grp = t.transfer_group || outRow?.transfer_group || inRow?.transfer_group || uuid();
      await put('transactions', {
        ...base, id: outRow?.id ?? uuid(), type: 'Transfer', account: from, currency: outCur,
        income: 0, expense: amt, transfer_group: grp, to_account: to, parent: 'Transfer',
        no: outRow?.no ?? null, note: base.note || `To ${to}`,
      });
      await put('transactions', {
        ...base, id: inRow?.id ?? uuid(), type: 'Transfer', account: to, currency: inCur,
        income: inAmt, expense: 0, transfer_group: grp, to_account: null, parent: null,
        no: inRow?.no ?? null, note: base.note || `From ${from}`,
      });
      toast(linked || (outRow && inRow) ? 'Transfer saved' : 'Transfer saved and linked');
    } else {
      const isIn = type === 'Income' || INFLOW.has(base.sub);
      await put('transactions', {
        ...base, id: t.id, type,
        income: isIn ? amt : 0, expense: isIn ? 0 : amt,
        no: t.no ?? (Math.max(0, ...DB.transactions.map(x => x.no || 0)) + 1),
      });
      toast(isNew ? 'Saved' : 'Updated');
    }
    if (base.payee && !DB.payees.some(p => p.name === base.payee)) await put('payees', { name: base.payee });
    if (base.parent && !DB.categories.some(c => c.parent === base.parent && (c.sub || '') === (base.sub || '')))
      await put('categories', { type, parent: base.parent, sub: base.sub || null });

    if (andAnother) reset(); else m.close();
  }

  /** Ready for the next entry, with the amount back at its starting 0. */
  function reset() {
    amountBoxA.set(0); amountBoxB.set(0);
    noteIn.value = '';
    amountIn.focus();
    refreshLanded(); updateFx();
  }

  const footer = [
    existing ? el('button', {
      class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
      onclick: async () => {
        // Deleting one leg of a transfer and leaving the other is how a balance
        // goes quietly wrong, so say plainly what is about to happen.
        const legs = t.transfer_group
          ? DB.transactions.filter(x => x.transfer_group === t.transfer_group && !x.deleted) : [];
        const msg = t.type !== 'Transfer'
          ? 'Delete this transaction? It disappears from every device.'
          : legs.length > 1
            ? `Delete both sides of this transfer (${legs.length} entries)? They disappear from every device.`
            : 'This transfer is not linked to its other half, so only THIS entry will go — '
              + 'the matching entry on the other account will stay behind and your balances will not agree. Delete it anyway?';
        if (!(await confirmBox(msg))) return;
        await remove('transactions', t.id);
        for (const p of legs) if (p.id !== t.id) await remove('transactions', p.id);
        toast('Deleted'); m.close();
      },
    }, 'Delete') : null,
    existing ? el('button', {
      class: 'btn', onclick: async () => {
        // A copy is the same entry on a new day — nothing else changes. For a
        // transfer that means BOTH sides, as a fresh pair of their own, or the
        // copy would be money arriving from nowhere.
        const date = todayISO();
        const time = new Date().toTimeString().slice(0, 5);
        let no = Math.max(0, ...DB.transactions.map(x => x.no || 0));
        const legs = t.transfer_group
          ? DB.transactions.filter(x => x.transfer_group === t.transfer_group && !x.deleted) : [];
        if (legs.length > 1) {
          const grp = uuid();
          for (const leg of legs) {
            await put('transactions', { ...leg, id: uuid(), date, time,
              fx: fxFor(date), transfer_group: grp, no: ++no });
          }
          toast(`Both sides copied to today`);
        } else {
          await put('transactions', { ...t, id: uuid(), date, time,
            fx: fxFor(date), transfer_group: null, no: ++no });
          toast('Copied to today');
        }
        m.close();
      },
    }, '⧉ Duplicate') : null,
    isNew ? el('button', { class: 'btn', onclick: () => save(true) }, 'Save + add another') : null,
    el('button', { class: 'btn primary', onclick: () => save(false) }, existing ? 'Update' : 'Save'),
  ].filter(Boolean);

  // Straight to the ledger from here — the fastest route to "what did I enter
  // yesterday", now that Transactions is no longer a tab.
  const history_ = el('button', {
    class: 'icon-btn', title: 'Past transactions', style: 'margin-right:2px',
    // Closing unwinds the sheet's history entry, which is asynchronous — so the
    // navigation waits for that to land or it would be undone a beat later.
    onclick: () => {
      addEventListener('popstate', () => { location.hash = '#/transactions'; }, { once: true });
      m.close();
      setTimeout(() => { if (location.hash !== '#/transactions') location.hash = '#/transactions'; }, 250);
    },
  }, '\u23f1');
  const m = modal(existing ? 'Edit transaction' : 'New transaction', body, { footer, lead: history_ });
  setTimeout(() => amountIn.focus(), 60);
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) save(false); });
  return m;
}

/** Quick-add straight from a saved template. */
export async function fireTemplate(tpl) {
  const p = tpl.payload || {};
  const fx = fxFor(todayISO());
  await put('transactions', {
    date: todayISO(), time: new Date().toTimeString().slice(0, 5), fx,
    type: p.type || 'Expense', account: p.account, currency: p.currency || currencyOf(p.account),
    income: p.type === 'Income' ? Number(p.amount) || 0 : 0,
    expense: p.type === 'Income' ? 0 : Number(p.amount) || 0,
    parent: p.parent || null, sub: p.sub || null, payee: p.payee || null,
    note: p.note || tpl.label,
    no: Math.max(0, ...DB.transactions.map(x => x.no || 0)) + 1,
  });
  toast(tpl.label + ' added');
}
