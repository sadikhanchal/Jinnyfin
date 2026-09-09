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

export const SYM = { SAR: 'ر.س', INR: '₹', USD: '$' };

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
 * A date that is still being typed rather than one somebody means.
 *
 * A native date field reports a COMPLETE value the moment its three parts make
 * any valid date. Type the "2" of 2026 into a box whose day and month are
 * already filled and the field says year 2 — a real date, 2023 years before the
 * one being aimed at. Every date in this app is a modern one, so a year under
 * 1000 can only mean the person has not finished typing.
 */
export const badYear = v => !!v && +String(v).slice(0, 4) < 1000;

/**
 * Wire a date box on a screen that redraws itself when the date changes.
 *
 * Without this, typing the "2" of 2026 hands over the year 2, the screen
 * redraws, and the box being typed into is destroyed with the keyboard still in
 * it — on a PC that means reaching for the mouse to get back in. `commit` is
 * called only for a date worth acting on, and again on the way out of the box.
 *
 * Pass a `key` and the screen can hand the cursor back afterwards with
 * restoreDateFocus(host).
 */
export function dateGuard(input, commit, key = null) {
  if (key) input.dataset.dk = key;
  const apply = () => {
    const v = input.value;
    if (badYear(v)) return;                     // still mid-year, leave it alone
    if (key) pendingDateFocus = key;
    commit(v);
  };
  input.onchange = apply;
  input.onblur = apply;                         // committed by leaving the box
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

export function confirmBox(msg, okLabel = 'Yes, do it') {
  return new Promise(res => {
    const wrap = el('div', { class: 'modal-wrap' });
    let disarm = () => {};
    const done = v => { disarm(); wrap.remove(); res(v); };
    const box = el('div', { class: 'modal small' },
      el('p', { class: 'confirm-msg' }, msg),
      el('div', { class: 'row end gap' },
        el('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancel'),
        el('button', { class: 'btn danger', onclick: () => done(true) }, okLabel)));
    wrap.append(box);
    dismissOnBackdrop(wrap, () => done(false));
    document.body.append(wrap);
    disarm = armBack(() => { wrap.remove(); res(false); });
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

export function modal(title, body, { wide = false, footer = null, lead = null } = {}) {
  const wrap = el('div', { class: 'modal-wrap' });
  let disarm = () => {};
  const close = () => { disarm(); wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' },
      lead, el('h3', {}, title),
      el('button', { class: 'icon-btn', onclick: close, title: 'Close' }, '✕')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null);
  wrap.append(box);
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
