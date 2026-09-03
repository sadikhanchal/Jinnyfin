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
export const todayISO = () => new Date().toISOString().slice(0, 10);
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
export function fmtDate(d) {
  if (!d) return '';
  const [y, m, dd] = iso(d).split('-');
  return `${dd} ${MON3[+m - 1]} ${y}`;
}
export function fmtDateShort(d) {
  if (!d) return '';
  const [y, m, dd] = iso(d).split('-');
  return `${dd} ${MON3[+m - 1]}`;
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
 */
function armBack(onBack) {
  let pushed = false;
  const pop = () => { pushed = false; off(); onBack(); };
  const off = () => removeEventListener('popstate', pop);
  try { history.pushState({ jfOverlay: 1 }, ''); pushed = true; } catch { pushed = false; }
  addEventListener('popstate', pop);
  return () => { off(); if (pushed) { pushed = false; history.back(); } };
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
    wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    document.body.append(wrap);
    disarm = armBack(() => { wrap.remove(); res(false); });
  });
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
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
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
