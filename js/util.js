// ---------------------------------------------------------------- utilities
export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      }));

// ------------------------------------------------------------------- dates
/**
 * Today where you are standing, not where the prime meridian is.
 *
 * toISOString() answers in UTC, so in Jeddah (UTC+3) everything between
 * midnight and 3am was dated to the day before — an entry made at 1am carried
 * yesterday's date with today's time on it.
 */
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
export const monthKey = d => iso(d).slice(0, 7);
export const monthStart = d => iso(d).slice(0, 8) + '01';
export const yearOf = d => +iso(d).slice(0, 4);
export const monthOf = d => +iso(d).slice(5, 7);

export const MONTHS = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
export const MON3 = MONTHS.map(m => m.slice(0, 3));

export function endOfMonth(y, m) {           // m = 1..12
  return iso(new Date(Date.UTC(y, m, 0)));
}
export function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
// Day-month-year, all digits, everywhere the app writes a date itself. The one
// place this cannot reach is the native date box: that widget is drawn by the
// phone or the PC in ITS OWN region format, and no page can override it.
export function fmtDate(d) {
  if (!d) return '';
  const [y, m, dd] = iso(d).split('-');
  return `${dd}-${m}-${y}`;
}
export function fmtDateShort(d) {
  if (!d) return '';
  const [, m, dd] = iso(d).split('-');
  return `${dd}-${m}`;
}

// ------------------------------------------------------------------ money
const NF = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

// Written left-to-right on purpose. The Arabic ﷼ mark is a right-to-left run,
// and a right-to-left run next to a figure drags the browser's own reordering
// into every line it sits in: "173% used" came out as "173ر.س% used", and a
// budget's "191 / 18" read back as "18 / 191". No symbol is worth a wrong number.
export const SYM = { SAR: 'SR ', INR: '₹', USD: '$' };

export function money(v, cur = 'INR', decimals = true) {
  const n = Number(v) || 0;
  const s = (decimals ? NF : NF0).format(Math.abs(n));
  const sign = n < 0 ? '-' : '';
  return `${sign}${SYM[cur] || ''}${s}`;
}
export function num(v, decimals = 2) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}
export function compact(v) {                  // 1234567 -> 12.35L
  const n = Math.abs(Number(v) || 0), sign = n === v ? '' : '-';
  if (n >= 1e7) return sign + (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return sign + (n / 1e5).toFixed(2) + 'L';
  if (n >= 1e3) return sign + (n / 1e3).toFixed(1) + 'K';
  return sign + n.toFixed(0);
}
export const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

// Small arithmetic in amount fields: "1200+340-15"
export function evalAmount(str) {
  const s = String(str ?? '').trim();
  if (!s) return 0;
  if (/^-?[\d.]+$/.test(s)) return Number(s);
  if (!/^[\d\s+\-*/().]+$/.test(s)) return NaN;
  try { return Number(Function('"use strict";return (' + s + ')')()) || 0; } catch { return NaN; }
}

// --------------------------------------------------------------- storage
// A browser with site data blocked throws on the very first localStorage read.
// Nothing here is important enough to take the app down for, so fall back to a
// plain object and carry on.
const memStore = { local: {}, session: {} };
function backing(kind) {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    s.setItem('__jf', '1'); s.removeItem('__jf');
    return s;
  } catch { return null; }
}
export const storageBlocked = () => backing('local') === null;
export function store(key, value, kind = 'local') {
  const s = backing(kind);
  if (value === undefined) {
    try { return s ? s.getItem(key) : memStore[kind][key] ?? null; } catch { return memStore[kind][key] ?? null; }
  }
  memStore[kind][key] = value;
  try { if (s) value === null ? s.removeItem(key) : s.setItem(key, value); } catch { /* memory only */ }
  return value;
}

// ------------------------------------------------------------------- DOM
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    n.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return n;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, kind = 'ok', ms = 2600, action = null) {
  let host = $('#toasts');
  if (!host) { host = el('div', { id: 'toasts' }); document.body.append(host); }
  const t = el('div', { class: `toast ${kind}` }, msg);
  if (action) {
    ms = Math.max(ms, 6000);
    t.append(el('button', {
      class: 'toast-action',
      onclick: () => { t.remove(); action.run(); },
    }, action.label));
  }
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, ms);
}

/**
 * Make the phone's back gesture close an overlay instead of leaving the page.
 * Returns a disarm function: call it when the overlay closes by other means,
 * and it unwinds the history entry so no dead back press is left behind.
 *
 * Overlays stack — a confirmation opens on top of the transaction sheet — and
 * only the topmost one may answer a back press. Each used to listen for
 * popstate on its own, so closing the confirmation ran its own history.back(),
 * and the sheet underneath heard that pop and closed itself too: press Cancel
 * on "Add this category?" and the whole half-typed transaction vanished. One
 * listener and a stack instead, with the pops we cause ourselves swallowed.
 */
const backStack = [];
let backSwallow = 0;
let pendingUnwind = 0;         // closes whose history.back() has not been sent yet
let unwindTimer = 0;

/**
 * Give back ONE entry we pushed, then wait for its popstate before the next.
 *
 * history.back() lands on a later tick. Firing several at once, or pushing a
 * new entry while one is still in flight, leaves the browser's stack somewhere
 * other than where this code thinks it is — and the last close then walks off
 * the page instead of shutting an overlay. So: one at a time, sequenced by the
 * popstate each one produces, and never a step onto an entry that is not ours.
 */
function unwindOne() {
  unwindTimer = 0;
  if (pendingUnwind <= 0) return;
  if (!history.state?.jfOverlay) { pendingUnwind = 0; return; }  // nothing of ours left to give back
  pendingUnwind--; backSwallow++; history.back();
}
const scheduleUnwind = () => {
  if (!unwindTimer && pendingUnwind > 0) unwindTimer = setTimeout(unwindOne, 0);
};

if (typeof addEventListener === 'function') {
  addEventListener('popstate', () => {
    if (backSwallow > 0) { backSwallow--; scheduleUnwind(); return; }   // our own unwinding, not a press
    const top = backStack.pop();
    if (top) top.onBack();
  });
}

function armBack(onBack) {
  let pushed = false;
  // One overlay closing and the next opening in the same breath — "Add this
  // category?" answered, and the next question straight after — must not push
  // on top of a back that has not landed yet. The depth is unchanged either
  // way, so the new overlay simply takes over the entry the old one was about
  // to give back.
  if (pendingUnwind > 0) { pendingUnwind--; pushed = true; }
  else { try { history.pushState({ jfOverlay: 1 }, ''); pushed = true; } catch { pushed = false; } }
  const entry = { onBack, pushed };
  backStack.push(entry);
  return () => {
    const i = backStack.indexOf(entry);
    if (i < 0) return;                    // the back press already dealt with it
    backStack.splice(i, 1);
    if (entry.pushed) { pendingUnwind++; scheduleUnwind(); }
  };
}

/**
 * Close an overlay by clicking the dimmed area around it — and only by that.
 *
 * A plain `click` listener is not enough. The browser fires click at the common
 * ancestor of where the button went DOWN and where it came UP, so pressing
 * inside a text field, dragging past the edge of the sheet and letting go
 * counts as a click on the backdrop. That is what threw away a half-typed
 * transaction whenever a description was selected with a slightly wide drag.
 * Both ends of the press have to land on the backdrop for it to be a dismissal.
 */
export function dismissOnBackdrop(wrap, close) {
  let began = false;
  wrap.addEventListener('pointerdown', e => { began = e.target === wrap; });
  wrap.addEventListener('pointerup', e => {
    const real = began && e.target === wrap;
    began = false;
    if (real) close();
  });
  wrap.addEventListener('pointercancel', () => { began = false; });
}

/**
 * The window a date in this ledger can sensibly fall in.
 *
 * A native date box will hand over a year of 2 or of 232323 just as readily as
 * 2026 — both are dates the browser calls valid. Only a year inside this range
 * is one somebody meant; anything outside it is a half-typed value or a slip,
 * and must never reach a filter, a chart axis, or a saved row.
 */
export const MIN_DATE = '1900-01-01';
export const MAX_DATE = '2100-12-31';

/** A date still being typed, or one nobody could have meant. */
export const badYear = v => {
  if (!v) return false;
  const y = +String(v).slice(0, 4);
  return !(y >= 1900 && y <= 2100);
};

/**
 * Put the range on the box itself, so the browser refuses what it can and the
 * person sees it refused rather than watching a filter empty out.
 */
export function dateBox(attrs = {}) {
  return el('input', { type: 'date', min: MIN_DATE, max: MAX_DATE, ...attrs });
}

/**
 * Wire a date box on a screen that redraws itself when the date changes.
 *
 * The rule here is one line: WHILE THE BOX HAS THE KEYBOARD, THE SCREEN DOES
 * NOT REDRAW. Everything else was a workaround for breaking it.
 *
 * A date box is three little fields in a trench coat, and the browser gives no
 * way to put the caret back on the middle one. So the moment a redraw throws
 * the box away and builds a new one, `focus()` lands on the FIRST segment —
 * and the next two digits you type go into the month when you meant the day.
 * Typing 11, pausing to think, then typing 28 gave 2026-02-08. No amount of
 * remembering which box had focus can fix that; the box has to survive.
 *
 * So the value is committed when the keyboard LEAVES — on blur, or on Enter.
 * A date picked from the calendar still lands at once: that arrives with no
 * keystroke behind it, and this can tell the difference.
 */
export function dateGuard(input, commit, key = null) {
  if (key) input.dataset.dk = key;
  if (!input.min) input.min = MIN_DATE;
  if (!input.max) input.max = MAX_DATE;
  let good = input.value;          // the value actually in force right now
  let timer = 0;
  /**
   * @param {boolean} leaving true when the keyboard is on its way out.
   *
   * Mid-typing a half-built date is simply not acted on: the year passes
   * through 2, then 20, then 202 on the way to 2026, and every one of those
   * is a date the browser calls valid. It is left alone — putting the box
   * back to its old value there would wipe what is being typed.
   *
   * On the way out is different. Whatever is left in the box then is what the
   * person meant, and if that is a year nobody meant, the box goes back to
   * the date actually filtering — because a box reading 2323 over a list that
   * ignores 2323 is worse than one that plainly refuses it.
   */
  const fire = (leaving = false) => {
    clearTimeout(timer);
    const v = input.value;
    if (badYear(v)) { if (leaving) input.value = good; return; }
    if (v === good) return;        // nothing changed — do not redraw, and do
    good = v;                      // not leave a focus request behind either
    if (key) pendingDateFocus = key;
    commit(v);
  };
  // Results follow the typing, a beat behind it. That is only safe because
  // the screens that use this no longer rebuild the box underneath the
  // caret — see the note on mount() in transactions.js. If a screen ever goes
  // back to wiping its filter bar on every draw, this becomes the bug where
  // typing 11 then 28 lands as 2026-02-08.
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => fire(false), 350); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fire(true); } });
  input.onchange = () => fire(false);
  input.onblur = () => fire(true);
  return input;
}

let pendingDateFocus = null;

/** Put the cursor back in the date box the redraw threw away. */
export function restoreDateFocus(host) {
  if (!pendingDateFocus || !host) return;
  const key = pendingDateFocus; pendingDateFocus = null;
  // preventScroll — focusing a box the browser thinks is out of view drags the
  // whole page to it, which is not what "put the cursor back" should mean.
  requestAnimationFrame(() => host.querySelector(`input[data-dk="${key}"]`)?.focus({ preventScroll: true }));
}

// ------------------------------------------------------- filter dropdowns --
let pendingFilterFocus = null;

/**
 * A filter <select> that redraws its page when it changes.
 *
 * A select fires `change` on EVERY arrow press. If the handler rebuilds the
 * page, the select the key was travelling through is thrown away with it and
 * the cursor goes with it — so the second press lands nowhere and the keyboard
 * is dead after one step. Every filter in the app worked that way.
 *
 * The key is remembered here and the cursor handed back after the redraw, so
 * ↑ and ↓ walk through years, months, categories and accounts without ever
 * reaching for the mouse, and Tab still moves to the next field.
 *
 * Wire the change through this rather than assigning `onchange` separately —
 * the order matters: the field has to be remembered BEFORE the redraw runs.
 */
export function onFilter(sel, key, fn) {
  sel.dataset.fk = key;
  sel.onchange = () => { pendingFilterFocus = key; fn(); };
  return sel;
}

/** Call at the end of a draw() that filters may have triggered. */
export function restoreFilterFocus(host) {
  if (!pendingFilterFocus || !host) return;
  const key = pendingFilterFocus; pendingFilterFocus = null;
  requestAnimationFrame(() => host.querySelector(`select[data-fk="${key}"]`)?.focus({ preventScroll: true }));
}

// ------------------------------------------------------ search combo box --
/**
 * A text box that picks from a fixed list — a `<select>` a person can type
 * into.
 *
 * A native select only jumps to an option whose FIRST letter matches what you
 * type, so "Al Rajhi" needs an "A", not an "R" — typing the word you actually
 * remember does nothing. This matches on the start of ANY word in an option,
 * so "Rajhi" and "Al" both find it.
 *
 * The box behaves like a real field: `.value` gets and sets the chosen value
 * without opening the list or firing `change` (same as a select's `.value =`),
 * `.addEventListener('change', …)` fires only for a person's own choice, and
 * `.setOptions(list)` replaces what it offers — call it again whenever the
 * list changes, the way a select's options are rebuilt today.
 *
 * `list` entries are `{ value, label, search }` — `search` is what typing is
 * matched against (the plain account name); `label` is what the closed list
 * shows (name plus currency, "(idle)", and so on).
 */
export function searchSelect(list = []) {
  const wrap = el('div', { class: 'combo' });
  const input = el('input', { type: 'text', autocomplete: 'off', style: 'width:100%' });
  const menu = el('div', { class: 'combo-list', hidden: true });
  wrap.append(input, menu);

  let options = list;
  let current = '';                 // the committed value
  let hi = -1;                      // index into `visible`, while the list is open
  let visible = [];

  const labelOf = v => options.find(o => o.value === v)?.label ?? '';
  const commit = (v, fire) => {
    current = v; input.value = labelOf(v);
    if (fire) wrap.dispatchEvent(new Event('change'));
  };

  const render = () => {
    menu.innerHTML = '';
    if (!visible.length) { menu.append(el('div', { class: 'combo-empty' }, 'No match')); return; }
    visible.forEach((o, i) => menu.append(el('div', {
      class: 'combo-opt' + (i === hi ? ' hi' : ''),
      // A click already has the value; blur must not run first and revert it.
      onmousedown: e => e.preventDefault(),
      onclick: () => { commit(o.value, true); close(); },
    }, o.label)));
  };

  const place = () => {
    const r = input.getBoundingClientRect();
    Object.assign(menu.style, { left: r.left + 'px', top: r.bottom + 'px', width: r.width + 'px' });
  };

  const open = q => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    visible = !words.length ? options
      : options.filter(o => words.every(w => o.search.toLowerCase().split(/\s+/).some(part => part.startsWith(w))));
    hi = visible.length ? 0 : -1;
    if (menu.hidden) window.addEventListener('scroll', place, true);
    place(); menu.hidden = false; render();
  };
  const close = () => {
    if (!menu.hidden) window.removeEventListener('scroll', place, true);
    menu.hidden = true; visible = []; hi = -1;
  };

  input.addEventListener('focus', () => { input.select(); open(''); });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('blur', () => {
    // Leaving without finishing a pick — put back what was actually chosen,
    // so a half-typed search never sits in the field as if it meant something.
    close(); input.value = labelOf(current);
  });
  input.addEventListener('keydown', e => {
    if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { open(input.value); return; }
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, visible.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, 0); render(); }
    else if (e.key === 'Enter') { if (visible[hi]) { e.preventDefault(); commit(visible[hi].value, true); close(); } }
    else if (e.key === 'Escape') { close(); input.value = labelOf(current); }
    else if (e.key === 'Tab' && visible.length === 1) { commit(visible[0].value, true); close(); }
  });

  Object.defineProperty(wrap, 'value', { get: () => current, set: v => commit(v, false) });
  wrap.setOptions = newList => { options = newList; if (!menu.hidden) open(input.value); else input.value = labelOf(current); };
  return wrap;
}

export function confirmBox(msg, okLabel = 'Yes, do it') {
  return new Promise(res => {
    const previous = document.activeElement;
    const selection = previous && typeof previous.selectionStart === 'number'
      ? { start: previous.selectionStart, end: previous.selectionEnd, direction: previous.selectionDirection }
      : null;
    const restore = () => {
      if (!previous?.isConnected || typeof previous.focus !== 'function') return;
      try { previous.focus({ preventScroll: true }); } catch { previous.focus(); }
      if (selection && typeof previous.setSelectionRange === 'function') {
        try { previous.setSelectionRange(selection.start, selection.end, selection.direction); } catch { /* not selectable */ }
      }
    };
    const wrap = el('div', { class: 'modal-wrap' });
    let disarm = () => {};
    let settled = false;
    const onKey = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      done(false);
    };
    const done = v => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      disarm(); wrap.remove();
      if (!v) restore();
      res(v);
    };
    const cancel = el('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancel');
    const box = el('div', { class: 'modal small' },
      el('p', { class: 'confirm-msg' }, msg),
      el('div', { class: 'row end gap' },
        cancel,
        el('button', { class: 'btn danger', onclick: () => done(true) }, okLabel)));
    wrap.append(box);
    trapFocus(box);
    dismissOnBackdrop(wrap, () => done(false));
    document.body.append(wrap);
    document.addEventListener('keydown', onKey, true);
    cancel.focus();
    disarm = armBack(() => done(false));
  });
}

/**
 * Close an overlay and only THEN do the thing. Closing unwinds the history
 * entry the overlay pushed, and that lands on a later tick — so navigating
 * straight away gets undone a beat later by the popstate still in flight.
 * This is what made "Open reminders" and the sheet's history button do nothing.
 */
export function closeThen(overlay, fn) {
  let done = false;
  const go = () => { if (done) return; done = true; removeEventListener('popstate', go); fn(); };
  addEventListener('popstate', go);
  setTimeout(go, 300);            // nothing was pushed, or the browser stayed quiet
  overlay.close();
}

/**
 * Keep the keyboard inside the sheet. Tab used to walk out of an open editor
 * and into the page behind it, so the next Enter pressed a button nobody could
 * see. Here Tab runs the sheet's own fields in order and wraps from the last
 * back to the first — and a date or time box is ONE stop, not three: its
 * segments are reached by typing into them, which is how they already behave.
 */
const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]';
export function trapFocus(box) {
  const stops = () => [...box.querySelectorAll(FOCUSABLE)].filter(n =>
    !n.disabled && n.tabIndex !== -1 && n.type !== 'hidden'
    && !n.closest('[hidden]') && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
  box.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const list = stops();
    if (!list.length) return;
    e.preventDefault();                       // we decide where it goes, not the browser
    const here = list.indexOf(document.activeElement);
    const next = here < 0 ? (e.shiftKey ? list.length - 1 : 0)
      : (here + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    const n = list[next];
    n.focus();
    if (typeof n.select === 'function' && /^(text|number|search|tel|url|password)$/.test(n.type || 'text')) {
      try { n.select(); } catch { /* not selectable */ }
    }
  });
}

export function modal(title, body, { wide = false, footer = null, lead = null } = {}) {
  const wrap = el('div', { class: 'modal-wrap' });
  let disarm = () => {};
  const close = () => { disarm(); wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  // The head's two buttons are for the pointer and for Escape. Leaving them in
  // the Tab order put a stop between Save and the first field for no purpose.
  if (lead) lead.tabIndex = -1;
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' },
      lead, el('h3', {}, title),
      el('button', { class: 'icon-btn', tabindex: '-1', onclick: close, title: 'Close' }, '✕')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null);
  wrap.append(box);
  trapFocus(box);
  dismissOnBackdrop(wrap, close);
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  // Back closes the sheet you are looking at, not the screen behind it.
  disarm = armBack(() => { wrap.remove(); document.removeEventListener('keydown', onKey); });
  return { wrap, box, close };
}

// CSV / download helpers
export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function downloadFile(name, content, type = 'text/csv;charset=utf-8') {
  // Excel needs a byte-order mark to read a UTF-8 CSV; JSON must NOT have one,
  // or every other program refuses to parse the backup we just handed them.
  const bom = /csv|text\/plain/i.test(type) ? '\ufeff' : '';
  const blob = content instanceof Blob ? content : new Blob([bom + content], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function downloadCSV(name, rows) {
  downloadFile(name, rows.map(r => r.map(csvCell).join(',')).join('\n'));
}
