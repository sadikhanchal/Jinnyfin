// ============================================================================
//  editor.js — add / edit a transaction (shared by every screen).
// ============================================================================
import { el, modal, toast, todayISO, uuid, evalAmount, confirmBox, money, round2, closeThen,
  badYear } from '../util.js';
import { DB, put, remove } from '../store.js';
import { fxFor, currencyOf, convertAmount, parentsFor, subsFor, parentsOfSub, payeeNames, eventNames,
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
  const rows = DB.categories.filter(c => c.type === 'Investment');
  const known = new Set(rows.map(c => c.parent));
  const seen = new Set(rows.filter(c => c.active !== false).map(c => c.parent));
  // A holding that only ever appeared on old entries still counts — but one
  // that has been archived on purpose stays out.
  for (const t of DB.transactions) {
    if (t.type === 'Investment' && t.parent && !known.has(t.parent)) seen.add(t.parent);
  }
  return [...seen].filter(Boolean).sort((a, b) => a.localeCompare(b));
};

/**
 * The same 60-day rule the rest of the app uses — not the stale flag the
 * workbook import brought with it.
 *
 * No sorting here. `DB.accounts` is already held in the arrangement set on
 * Settings → Reconcile, and this dropdown re-sorting it by group and name is
 * what made that arrangement look like it only worked on the Reconcile page.
 */
const activeAccounts = () => liveAccounts().slice();
const everyAccount = () => DB.accounts.filter(a => !a.deleted);

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

/**
 * The next entry number. Walking the ledger looks clumsier than
 * `Math.max(...rows)`, but that spread is one argument per row: 25,000 is
 * survivable on a desktop and JavaScriptCore on an iPhone gives out around
 * 65,000, throwing while the row object is still being built — so Save would
 * quietly do nothing at all, with no toast and no saved entry.
 */
const nextNo = () => DB.transactions.reduce((m, x) => Math.max(m, +x.no || 0), 0) + 1;

/** The account you used last — a much better default than whatever sorts first. */
function lastUsedAccount() {
  for (let i = DB.transactions.length - 1; i >= Math.max(0, DB.transactions.length - 50); i--) {
    const n = DB.transactions[i].account;
    if (DB.accounts.some(a => a.name === n)) return n;
  }
  return activeAccounts()[0]?.name || '';
}

/**
 * What a typed value should become once you leave the box.
 *
 *   exact — it already is one of them; keep it
 *   one   — it narrows to exactly one; finish the word
 *   many  — still ambiguous ("F" across a dozen categories); clear it, because
 *           a half-typed name is not a category and saving it would invent one
 *   none  — nothing remotely like it; keep it and offer to add it
 *   empty — nothing typed
 */
export function settleList(raw, options) {
  const v = String(raw ?? '').trim();
  if (!v) return { state: 'empty', value: '' };
  const low = v.toLowerCase();
  const exact = options.find(o => String(o).toLowerCase() === low);
  if (exact) return { state: 'exact', value: exact };
  const hits = options.filter(o => String(o).toLowerCase().startsWith(low));
  if (hits.length === 1) return { state: 'one', value: hits[0] };
  if (hits.length) return { state: 'many', value: '' };
  return { state: 'none', value: v };
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
  // tabindex -1: these are for the thumb, not the keyboard. On a PC the number
  // row and the numeric keypad already carry + − × ÷, so making Tab walk through
  // five buttons on the way from Amount to Account only slowed entry down.
  const key = (label, run, cls = '') => el('button', {
    type: 'button', class: 'calc-key' + cls, tabindex: '-1',
    onpointerdown: claim, ontouchstart: claim, onmousedown: claim,
    onclick: e => { e.preventDefault(); keyPress = false; run(); },
  }, label);
  const calcKeys = el('div', { class: 'calc-keys' },
    ...[['+', '+'], ['−', '-'], ['×', '*'], ['÷', '/']]
      .map(([label, ch]) => key(label, () => (live || boxes[0]).insert(ch))),
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

  let lastA = null;             // what the amount box held last time it settled
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

  // ── boxes backed by a list ───────────────────────────────────────────────
  // Anything at all used to be typeable here, and save() then created it
  // without asking — so one slip of the keyboard left "dfasdaasd" sitting in
  // the dropdown for good. Now the box settles itself when you leave it, and
  // anything genuinely new has to be agreed to first.
  const approved = new Set();                 // new names said yes to, this sheet
  const chipFor = () => el('div', { class: 'newchip', hidden: true });
  const parentChip = chipFor(), subChip = chipFor(), payeeChip = chipFor(), eventChip = chipFor();

  function listBox(input, chip, optionsFor, noun, after = null) {
    let onChip = false;
    // A pointer going down on the chip must not let the blur tear it away
    // before the click lands — the same trick the calculator keys use.
    chip.addEventListener('pointerdown', () => { onChip = true; });
    const clear = () => { chip.replaceChildren(); chip.hidden = true; };
    const settle = () => {
      clear();
      const r = settleList(input.value, optionsFor());
      input.value = r.value;
      if (after) after(r, chip);
      refreshLists();
      if (!chip.hidden) return;              // the hook already has something to say
      if (r.state !== 'none' || approved.has(`${noun}:${r.value}`)) return;
      chip.hidden = false;
      chip.append(
        el('span', {}, `“${r.value}” is not in your list yet.`),
        el('button', { type: 'button', class: 'btn xs primary', tabindex: '-1',
          onclick: () => { approved.add(`${noun}:${r.value}`); clear(); } }, 'Add it'),
        el('button', { type: 'button', class: 'btn xs ghost', tabindex: '-1',
          onclick: () => { input.value = ''; clear(); refreshLists(); } }, 'Clear'));
    };
    input.addEventListener('blur', () => {
      if (onChip) { onChip = false; return; }
      settle();
    });
    return settle;
  }

  const settleParent = listBox(parentIn, parentChip,
    () => parentsFor(type === 'Transfer' ? null : type), 'category');
  // The sub-category box searches the whole type when no category is named, and
  // then names the category itself. Nobody should have to remember which of
  // twenty categories "Diesel" was filed under in order to be allowed to type
  // it. When two categories share the sub — a "Gifts" under Personal and
  // another under Family — the app cannot know which, so it says so and offers
  // the actual two to choose from rather than leaving him to guess at the list.
  const settleSub = listBox(subIn, subChip,
    () => subsFor(type === 'Transfer' ? null : type, parentIn.value), 'sub-category',
    (r, chip) => {
      if (!r.value || parentIn.value.trim()) return;
      const owners = parentsOfSub(type === 'Transfer' ? null : type, r.value);
      if (owners.length === 1) { parentIn.value = owners[0]; return; }
      if (owners.length < 2) return;
      chip.hidden = false;
      chip.append(el('span', {}, `“${r.value}” is in ${owners.length} categories — which one?`));
      for (const p of owners) {
        chip.append(el('button', { type: 'button', class: 'btn xs primary', tabindex: '-1',
          onclick: () => {
            parentIn.value = p;
            chip.replaceChildren(); chip.hidden = true;
            refreshLists();
          } }, p));
      }
    });
  const settlePayee = listBox(payeeIn, payeeChip, payeeNames, 'payee');
  const settleEvent = listBox(eventIn, eventChip, eventNames, 'event');
  const settleAll = () => { settleParent(); settleSub(); settlePayee(); settleEvent(); };

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

  // A transfer is edited as one thing — "this much left here, that much landed
  // there" — whichever of its two rows you happened to tap. Reading the amount
  // off the tapped row put the LANDED figure in the Amount box when you opened
  // the receiving side, and saving then wrote that back as the amount sent.
  if (linked) {
    amountBoxA.set(Number(outLeg.expense) || 0);
    lastA = amountBoxA.value();
    if (+inLeg.income) { amountBoxB.set(inLeg.income); amountBoxB.touched = true; }
    // The rest of the entry belongs to the out leg too, or re-saving from the
    // receiving side would relabel both rows "From …".
    for (const [box, val] of [[noteIn, outLeg.note], [payeeIn, outLeg.payee], [eventIn, outLeg.event]])
      box.value = val || '';
    dateIn.value = outLeg.date || dateIn.value;
    timeIn.value = outLeg.time || timeIn.value;
  }

  // Idle accounts are out of the way by default, but one tick brings them all
  // back — which is how you give an old unlinked transfer its real other side.
  let showIdle = false;
  // Also out of the tab run, for the same reason: it sits between Amount and
  // Account, and it is a once-in-a-while tick, not part of entering a row.
  const idleTick = el('input', { type: 'checkbox', tabindex: '-1' });
  idleTick.addEventListener('change', () => {
    showIdle = idleTick.checked;
    fillAccounts();
    syncCurrency();
  });
  const idleRow = el('label', { class: 'idle-tick', title: 'Show accounts with nothing on them for 60 days' },
    idleTick, el('span', {}, 'View inactive accounts'));

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
   * Changing what LEFT is a deliberate change to the transfer, so the landed
   * figure is worked out again. But merely LEAVING the amount box is not a
   * change — and treating it as one threw away the figure you had just typed
   * into the landed box, turning ₹2,500 → $25.18 into ₹2,500 → $29.66 the
   * moment you pressed Update.
   */
  function onAmountChanged(box) {
    if (box === amountBoxA) {
      const now = amountBoxA.value();
      if (lastA !== null && now !== lastA) amountBoxB.touched = false;
      lastA = now;
      refreshLanded();
    }
    updateFx();
  }

  // The rate used to have a line of its own under the form. It is already on
  // the amount itself when it matters, so the line was just length.
  const updateFx = () => {
    const cur = curSel.value;
    if (cur === 'INR' || type === 'Transfer') { fxNote.textContent = ''; return; }
    const amt = evalAmount(amountIn.value) || 0;
    fxNote.textContent = amt ? '≈ ' + money(convertAmount(amt, cur, 'INR', dateIn.value), 'INR') : '';
  };
  acctSel.addEventListener('change', syncCurrency);
  toSel.addEventListener('change', () => { amountBoxB.touched = false; refreshLanded(); });
  // Half a year is not a date to convert money at — the rate line would flash
  // "Rate for 0002-09" at somebody in the middle of typing 2026.
  dateIn.addEventListener('change', () => {
    if (badYear(dateIn.value)) return;
    // `touched` is deliberately NOT cleared here. Changing the To account
    // changes the currency, so what landed really must be worked out again —
    // but a date is corrected far more often than the landed figure is wrong,
    // and clearing it rewrote 1,000 SAR that actually arrived as ₹22,400 into
    // ₹25,239 the moment a one-day typo was fixed.
    refreshLanded(); updateFx();
  });

  function refreshLists() {
    const catType = type === 'Transfer' ? null : type;
    for (const id of ['dl-parent', 'dl-sub', 'dl-payee', 'dl-event']) body.querySelector('#' + id)?.remove();
    body.append(datalist('dl-parent', parentsFor(catType)));
    body.append(datalist('dl-sub', subsFor(catType, parentIn.value)));
    body.append(datalist('dl-payee', payeeNames()));
    body.append(datalist('dl-event', eventNames()));
  }
  parentIn.addEventListener('input', refreshLists);

  /**
   * Short is the whole point. This is the screen he opens several times a day
   * with a keyboard already covering half the phone, so every field earns its
   * line: the account carries its own currency, the rate speaks only when it
   * changes an amount, and everything that pairs sits side by side.
   */
  function layout() {
    form.innerHTML = '';
    const add = (label, node, cls = '', extra = null) =>
      form.append(el('div', { class: 'field ' + cls }, el('label', {}, label), node, extra));
    add('Amount', amountIn, 'full', fxNote);
    form.append(landedField);                 // only visible when two currencies meet
    form.append(el('div', { class: 'full calc-line' }, calcKeys, idleRow));

    if (type === 'Transfer') { add('From account', acctSel); add('To account', toSel); }
    else add('Account', acctSel, 'full');
    add('Date', dateIn); add('Time', timeIn);

    if (type === 'Lend/Borrow' || type === 'Investment') {
      syncFixed(t.sub);
      add(type === 'Investment' ? 'Holding' : 'Category', catSel);
      add(type === 'Investment' ? 'Action' : 'Sub-category', subSel);
    } else if (type !== 'Transfer') {
      add('Category', parentIn, '', parentChip);
      add('Sub-category', subIn, '', subChip);
    }

    if (type === 'Lend/Borrow') add('Payee', payeeIn, 'full', payeeChip);
    else { add('Payee / tag', payeeIn, '', payeeChip); add('Event', eventIn, '', eventChip); }
    add('Description', noteIn, 'full');
    if (type === 'Transfer' && !linked && !isNew) {
      form.append(el('div', { class: 'full alert soon' }, el('span', { class: 'ico' }, '🔗'),
        el('div', {}, 'This transfer was brought in from the workbook and is not tied to its other half. '
          + `Pick the ${rowIsIn ? 'account it came from' : 'account it went to'} and Jinnyfin will find that entry and link the two. `
          + 'Leave it as “not known” and only this row is saved.')));
    }
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
      //
      // Coming back to the row's OWN type restores the category it was saved
      // with — not whatever the type you passed through left in the box. Going
      // Expense → Lend → Expense used to bring "Borrow" back with it, and
      // "Borrow" is an inflow: the row then saved a spend as money received.
      const home = existing && existing.type === ty;
      parentIn.value = home ? (t.parent || '') : '';
      subIn.value = home ? (t.sub || '') : '';
      layout();
    }, dataset: { ty } },
      el('span', { class: 'ti' }, ICON[ty]),
      el('span', { class: 'tl' }, { 'Lend/Borrow': 'Lend', Investment: 'Invest' }[ty] || ty));
    typeRow.append(b);
  }
  layout();
  syncCurrency();

  // -------------------------------------------------------------- save ----
  /**
   * Nothing here may fail in silence. A write that rejects — no space left on
   * the phone is the common one — used to leave the sheet sitting open with no
   * message, looking exactly like a Save that had simply not been pressed.
   */
  async function guard(andAnother) {
    try { await save(andAnother); } catch (e) {
      console.error('[save]', e);
      toast('Could not save: ' + (e?.message || e), 'warn', 6000);
    }
  }

  async function save(andAnother = false) {
    // Tidy the list boxes first, in case Save was reached without leaving one.
    settleAll();
    const amt = amountBoxA.value();
    if (!isFinite(amt) || amt === 0) { toast('Enter an amount', 'warn'); amountIn.focus(); return; }
    if (!acctSel.value) { toast('Pick an account', 'warn'); return; }
    // Saving straight after typing the first digit of the year would file this
    // in the year 2 — and then every date range in the app steps around it.
    if (badYear(dateIn.value) || !dateIn.value) {
      toast('Finish the date first', 'warn'); dateIn.focus(); return;
    }
    // Every entry needs a category. Without one it is money that happened and
    // belongs to nothing: no report counts it, no budget sees it, and it can
    // only ever be found by scrolling. A transfer is the exception — it carries
    // "Transfer" — and an opening balance is not a spend at all.
    if (type !== 'Transfer' && type !== 'Opening Balance' && !parentIn.value.trim()) {
      const s = subIn.value.trim();
      const owners = s ? parentsOfSub(type, s) : [];
      // Naming them is the whole point: being told a sub is "under more than
      // one category" without being told WHICH ones leaves you guessing at a
      // dropdown of fifty.
      if (owners.length > 1) toast(`“${s}” is under ${owners.join(' or ')} — pick which one`, 'warn', 6000);
      else toast('Pick a category', 'warn');
      parentIn.focus(); return;
    }
    const fx = fxFor(dateIn.value);
    const base = {
      date: dateIn.value, time: timeIn.value || null, account: acctSel.value,
      currency: curSel.value, parent: parentIn.value.trim() || null, sub: subIn.value.trim() || null,
      payee: payeeIn.value.trim() || null, event: eventIn.value.trim() || null,
      note: noteIn.value.trim() || null, fx,
    };

    // Anything still new gets asked about ONCE, before a single row is written.
    // Cancelling leaves the sheet exactly as it is so the spelling can be fixed
    // — which is the whole point, and better than discovering "fghdfgdh" in the
    // dropdown next month.
    {
      const catType = type === 'Transfer' ? null : type;
      const pending = [];
      if (base.parent && !approved.has('category:' + base.parent)
        && !parentsFor(catType).includes(base.parent)) pending.push(`category “${base.parent}”`);
      if (base.parent && base.sub && !approved.has('sub-category:' + base.sub)
        && !subsFor(catType, base.parent).includes(base.sub))
        pending.push(`sub-category “${base.sub}” under ${base.parent}`);
      if (base.payee && !approved.has('payee:' + base.payee)
        && !payeeNames().includes(base.payee)) pending.push(`payee “${base.payee}”`);
      if (base.event && !approved.has('event:' + base.event)
        && !eventNames().includes(base.event)) pending.push(`tag “${base.event}”`);
      if (pending.length && !(await confirmBox(
        `Add ${pending.join(' and ')} to your lists?`, 'Add'))) return;
    }

    if (type === 'Transfer') {
      const from = acctSel.value, to = toSel.value;
      const known = from !== UNKNOWN && to !== UNKNOWN;

      // Both accounts must be selected — never save a one-legged transfer.
      if (!known) {
        const missing = from === UNKNOWN ? 'From account' : 'To account';
        toast(`Select ${missing}`, 'warn');
        (from === UNKNOWN ? acctSel : toSel).focus();
        return;
      }

      if (from === to) { toast('From and To must differ', 'warn'); return; }

      const outCur = currencyOf(from), inCur = currencyOf(to);
      const inAmt = outCur === inCur ? amt : amountBoxB.value();
      if (!isFinite(inAmt) || inAmt === 0) {
        toast(`Enter what landed in ${to}`, 'warn'); landedField.querySelector('input').focus(); return;
      }

      let outRow = linked ? outLeg : (rowIsIn ? null : t);
      let inRow = linked ? inLeg : (rowIsIn ? t : null);

      // An OLD row whose other half was never linked, and he has now named the
      // other side: the partner is already sitting in the ledger, so find it and
      // tie the two together — writing a fresh row instead doubles the money.
      //
      // A brand-new transfer is not this case. Both its rows are being written
      // here and now, so there is nothing to search for and nothing to ask
      // about — and searching would let it adopt an unrelated orphan that
      // happens to share the date, account and amount.
      if (!linked && !isNew) {
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
      // Two rows, and both have to land. If the second write fails — a phone
      // with no space left aborts the whole IndexedDB transaction — the first
      // must not be left standing, or money has left one account and arrived
      // nowhere, with nothing on screen to say so.
      const outId = outRow?.id ?? uuid();
      await put('transactions', {
        ...base, id: outId, type: 'Transfer', account: from, currency: outCur,
        income: 0, expense: amt, transfer_group: grp, to_account: to,
        // Keep the category the row already carried. Hard-writing 'Transfer'
        // here wiped it: a KSFE installment filed as a transfer lost its tag
        // the moment it was re-saved, and that money left net worth silently.
        parent: base.parent || 'Transfer',
        no: outRow?.no ?? null, note: base.note || `To ${to}`,
      });
      // Both legs carry the same category. The arriving side used to be left
      // blank, so the very same transfer read "Transfer" on the account it left
      // and showed an empty Category column on the account it landed in.
      try {
        await put('transactions', {
          ...base, id: inRow?.id ?? uuid(), type: 'Transfer', account: to, currency: inCur,
          income: inAmt, expense: 0, transfer_group: grp, to_account: null,
          parent: base.parent || 'Transfer',
          no: inRow?.no ?? null, note: base.note || `From ${from}`,
        });
      } catch (e) {
        if (!outRow?.id) await remove('transactions', outId).catch(() => {});
        throw e;
      }
      toast(linked || (outRow && inRow) ? 'Transfer saved' : 'Transfer saved and linked');
    } else {
      // The same rule the Amount box paints itself by (see paintAmount). The
      // two used to disagree: this line applied the inflow list to EVERY type,
      // so an Expense whose sub happened to be one of those words was written
      // as income while the screen showed it in red as a spend — and the
      // account moved by twice the amount, the wrong way.
      const isIn = type === 'Income'
        || ((type === 'Lend/Borrow' || type === 'Investment') && INFLOW.has(base.sub));

      // Turning a transfer into something else. This row keeps its id and
      // becomes the new entry — but its other leg is still sitting on the other
      // account, so the same money is counted twice: once as a transfer in, and
      // again as this. That is how an account quietly went ₹1.8 lakh wrong.
      //
      // The partner goes with it, and the transfer links are written away as
      // null rather than simply left out: an upsert only overwrites the columns
      // it is handed, so an omitted transfer_group survives on the server and
      // comes back on the next sync — after which deleting this row takes an
      // unrelated entry down with it.
      const partners = (existing && existing.type === 'Transfer' && t.transfer_group)
        ? DB.transactions.filter(x => x.transfer_group === t.transfer_group && x.id !== t.id && !x.deleted)
        : [];
      if (partners.length && !(await confirmBox(
        `This is one side of a transfer. Changing it to ${type} also removes the matching entry on `
        + `${[...new Set(partners.map(p => p.account))].join(' and ')} — otherwise the same money is `
        + 'counted twice. Go ahead?', 'Change it'))) return;

      await put('transactions', {
        ...base, id: t.id, type,
        income: isIn ? amt : 0, expense: isIn ? 0 : amt,
        no: t.no ?? nextNo(),
        transfer_group: null, to_account: null,
      });
      for (const p of partners) await remove('transactions', p.id);
      toast(isNew ? 'Saved' : partners.length ? 'Changed — the other half was removed' : 'Updated');
    }
    if (base.payee && !DB.payees.some(p => p.name === base.payee)) await put('payees', { name: base.payee });
    // `c.type === type` matters: without it, using a name that already exists
    // under Expense in an Income entry matched here and no row was made, so the
    // name never turned up in Income's own dropdown.
    if (base.parent && !DB.categories.some(c => c.type === type
      && c.parent === base.parent && (c.sub || '') === (base.sub || '')))
      await put('categories', { type, parent: base.parent, sub: base.sub || null });

    if (andAnother) reset(); else m.close();
  }

  /**
   * Ready for the next entry, with the amount back at its starting 0.
   *
   * The identity has to be thrown away and minted again. `put` is an upsert
   * keyed on id, so carrying the same id into the next save rewrote the row
   * just written instead of adding one — five entries down "Save + add another"
   * left a single row, the last one, and the four before it were gone. The row
   * number and the transfer links go with it: they belong to the entry that was
   * just saved, not to the blank one now on screen.
   */
  function reset() {
    t.id = uuid();
    t.no = undefined;
    t.transfer_group = null;
    t.to_account = null;
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
        // Spreading a whole ledger into Math.max is an argument per row, which
        // a long history can push past what the engine accepts. Walk it.
        let no = DB.transactions.reduce((m2, x) => Math.max(m2, +x.no || 0), 0);
        const legs = t.transfer_group
          ? DB.transactions.filter(x => x.transfer_group === t.transfer_group && !x.deleted) : [];
        if (legs.length > 1) {
          const grp = uuid();
          for (const leg of legs) {
            await put('transactions', { ...leg, id: uuid(), date, time,
              fx: fxFor(date), transfer_group: grp, no: ++no });
          }
          toast(`Both sides copied to today`);
        } else if (t.type === 'Transfer') {
          // Half a transfer copied on its own is money appearing out of nowhere
          // on one account. Link the other side first, then copy the pair.
          toast('This transfer has only one side linked — fix that before copying it', 'warn', 5000);
          return;
        } else {
          await put('transactions', { ...t, id: uuid(), date, time,
            fx: fxFor(date), transfer_group: null, no: ++no });
          toast('Copied to today');
        }
        m.close();
      },
    }, '⧉ Duplicate') : null,
    isNew ? el('button', { class: 'btn', onclick: () => guard(true) }, 'Save + add another') : null,
    el('button', { class: 'btn primary', onclick: () => guard(false) }, existing ? 'Update' : 'Save'),
  ].filter(Boolean);

  // Straight to the ledger from here — the fastest route to "what did I enter
  // yesterday", now that Transactions is no longer a tab.
  const history_ = el('button', {
    class: 'icon-btn lead-btn', title: 'Past transactions',
    onclick: () => closeThen(m, () => { location.hash = '#/transactions'; }),
  }, '\ud83d\udd52');
  const m = modal(existing ? 'Edit transaction' : 'New transaction', body, { footer, lead: history_ });
  // Selected, not just focused. A new sheet opens on "0" and the focus handler
  // selects that for you; an existing entry opens on a real figure and used to
  // drop the caret at the far left, so correcting 3,849 meant deleting it by
  // hand first. Typing now replaces the number outright, as it should.
  setTimeout(() => { amountIn.focus(); amountIn.select(); }, 60);
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) guard(false); });
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
    no: nextNo(),
  });
  toast(tpl.label + ' added');
}
