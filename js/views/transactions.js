// ============================================================================
//  transactions.js — the full ledger: search, filter, duplicate, edit, export.
// ============================================================================
import { el, money, fmtDate, MONTHS, debounce, downloadCSV, todayISO, toast, confirmBox, uuid } from '../util.js';
import { DB, putMany, remove } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { openTxEditor, typeIcon } from './editor.js';

const PAGE = 150;
const blank = () => ({ text: '', type: 'All', account: 'All', parent: 'All', payee: 'All',
                       year: 'All', month: 'All', from: '', to: '' });
let f = blank();
let shown = PAGE, host = null;
let picking = false;            // multi-select mode
const picked = new Set();       // ids chosen while picking

// Selection is a mode, not a setting: arriving at this screen always starts
// clean, and there is exactly one way out of it that also clears the ticks.
let pickPushed = false;

export async function render(root) {
  host = root;
  picking = false; picked.clear(); pickPushed = false;
  draw();
}
export function refresh() { if (host) draw(); }

function startPicking(id) {
  if (picking) { if (id) picked.add(id); draw(); return; }
  picking = true;
  if (id) picked.add(id);
  // So the phone's back gesture leaves selection mode instead of the screen.
  try { history.pushState({ jfPick: 1 }, ''); pickPushed = true; } catch { pickPushed = false; }
  draw();
}

/** @param {boolean} rewind also drop the history entry selection mode added. */
function stopPicking(rewind = true) {
  if (!picking) return;
  picking = false; picked.clear();
  if (rewind && pickPushed) { pickPushed = false; history.back(); }
  else pickPushed = false;
  draw();
}

addEventListener('popstate', () => { if (picking) { pickPushed = false; stopPicking(false); } });

// ---------------------------------------------------------------- copying --
/** A copy of a row stamped with now: same money, same category, new identity. */
function copyOf(t, seq) {
  const date = todayISO();
  return {
    ...t, id: uuid(), date, time: new Date().toTimeString().slice(0, 5),
    fx: C.fxFor(date), no: seq, transfer_group: null, updated_at: undefined,
  };
}

async function duplicate(rows) {
  if (!rows.length) return;
  let seq = Math.max(0, ...DB.transactions.map(x => x.no || 0));
  const copies = rows.map(t => copyOf(t, ++seq));
  await putMany('transactions', copies);
  const ids = copies.map(c => c.id);
  toast(`${copies.length} copied to today`, 'ok', 6000, {
    label: 'Undo',
    run: async () => { for (const id of ids) await remove('transactions', id); toast('Undone'); },
  });
  stopPicking();
}

// ------------------------------------------------------------------ view ---
function draw() {
  const keepScroll = window.scrollY;
  host.innerHTML = '';
  const rows = C.filterTx(f).slice().reverse();

  host.append(topbar('Transactions',
    el('button', { class: 'btn sm' + (picking ? ' primary' : ''),
      onclick: () => (picking ? stopPicking() : startPicking(null)) }, picking ? 'Done' : '☑ Select'),
    el('button', { class: 'btn sm', onclick: () => exportCSV(rows) }, '⬇ CSV'),
    el('button', { class: 'btn sm primary', onclick: () => openTxEditor() }, '+ Add')));

  // ------------------------------------------------------------ search ----
  const search = el('input', { type: 'search', value: f.text,
    placeholder: 'Search description, category, payee, amount…', enterkeyhint: 'search' });
  search.addEventListener('input', debounce(() => {
    f.text = search.value; shown = PAGE; draw();
    const s = host.querySelector('.searchbar input');
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }, 280));
  host.append(el('div', { class: 'searchbar' },
    el('span', { class: 'mag' }, '🔍'), search,
    f.text ? el('button', { class: 'icon-btn clear', onclick: () => { f.text = ''; shown = PAGE; draw(); } }, '✕') : null));

  // ----------------------------------------------------------- filters ----
  const sel = (label, key, options) => {
    const s = el('select', {}, el('option', { value: 'All' }, 'All'),
      ...options.map(o => el('option', { value: o.v ?? o, selected: String(f[key]) === String(o.v ?? o) }, o.t ?? o)));
    s.onchange = () => { f[key] = s.value; shown = PAGE; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  const dateIn = (label, key) => {
    const i = el('input', { type: 'date', value: f[key] || '' });
    i.onchange = () => { f[key] = i.value; shown = PAGE; draw(); };
    return el('div', { class: 'field' }, el('label', {}, label), i);
  };
  host.append(el('div', { class: 'filters' },
    sel('Type', 'type', C.TYPES),
    sel('Account', 'account', C.accountNames()),
    sel('Category', 'parent', C.parentsFor(null)),
    sel('Payee', 'payee', C.payeeNames()),
    sel('Year', 'year', C.yearsPresent()),
    sel('Month', 'month', MONTHS.map((m, i) => ({ v: i + 1, t: m }))),
    dateIn('From', 'from'), dateIn('To', 'to'),
    el('div', { class: 'field' }, el('label', {}, ' '),
      el('button', { class: 'btn sm', onclick: () => { f = blank(); shown = PAGE; draw(); } }, 'Clear'))));

  // ----------------------------------------------------------- summary ----
  const eqIn = rows.reduce((s, t) => s + C.inrOf(t), 0);
  const eqOut = rows.reduce((s, t) => s + C.inrOut(t), 0);
  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-bottom:12px' },
    mini('Entries', rows.length.toLocaleString('en-IN')),
    mini('▲ In', money(eqIn, 'INR', false), 'income'),
    mini('▼ Out', money(eqOut, 'INR', false), 'expense'),
    mini('Net', money(eqIn - eqOut, 'INR', false), eqIn - eqOut >= 0 ? '' : 'expense')));

  // The gesture differs by device, so name only the one this device has.
  const canHover = window.matchMedia?.('(hover: hover)').matches;
  if (!picking) host.append(el('p', { class: 'hint', style: 'margin:-6px 0 8px' },
    (canHover ? 'Point at a row to duplicate it' : 'Swipe a row left to duplicate it')
    + ' · long-press or “Select” for several at once'));

  // -------------------------------------------------------------- list ----
  const list = el('div', {});
  let lastDay = null;
  const slice = rows.slice(0, shown);
  for (const t of slice) {
    if (t.date !== lastDay) {
      lastDay = t.date;
      const day = rows.filter(x => x.date === t.date);
      const net = day.reduce((s, x) => s + C.inrOf(x) - C.inrOut(x), 0);
      list.append(el('div', { class: 'tx-day' }, fmtDate(t.date),
        el('span', {},
          picking ? el('button', {
            class: 'chip pickday', title: 'Select this whole day',
            onclick: () => { day.forEach(x => picked.add(x.id)); draw(); },
          }, '＋ day') : null,
          el('span', { class: net >= 0 ? 'pos' : 'neg' }, money(net, 'INR', false)))));
    }
    list.append(txRow(t));
  }
  host.append(list);

  if (rows.length > shown) {
    host.append(el('div', { style: 'text-align:center;padding:14px' },
      el('button', { class: 'btn', onclick: () => { shown += PAGE * 2; draw(); } },
        `Show more (${(rows.length - shown).toLocaleString('en-IN')} left)`)));
  }
  if (!rows.length) host.append(el('div', { class: 'empty' },
    el('div', { class: 'big' }, '🔍'), el('p', {}, 'Nothing matches those filters.')));

  // --------------------------------------------------- selection actions --
  if (picking) {
    const chosen = () => rows.filter(t => picked.has(t.id));
    host.append(el('div', { class: 'selbar' },
      el('b', {}, picked.size ? `${picked.size} selected` : 'Tap the rows you want'),
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn sm ghost', onclick: () => stopPicking() }, 'Cancel'),
      el('button', {
        class: 'btn sm primary', disabled: !picked.size,
        onclick: () => picked.size && duplicate(chosen()),
      }, '⧉ Duplicate to today')));
  }

  // Only when the redraw was triggered from inside this screen. On a fresh
  // arrival the router restores where you last were, and must not be fought.
  if (keepScroll) requestAnimationFrame(() => window.scrollTo(0, keepScroll));
}

function mini(label, value, cls = '') {
  return el('div', { class: 'card tight stat ' + cls },
    el('div', { class: 'label' }, label), el('div', { class: 'value tnum', style: 'font-size:19px' }, value));
}

// ------------------------------------------------------------------ a row --
export function txRow(t) {
  const isIn = Number(t.income) > 0;
  const amt = isIn ? t.income : t.expense;
  const sub = [t.account, t.parent, t.sub, t.payee].filter(Boolean).join(' · ');

  const row = el('div', { class: 'tx' + (picked.has(t.id) ? ' picked' : '') },
    picking
      ? el('input', { type: 'checkbox', class: 'pick', checked: picked.has(t.id) })
      : el('div', { class: 'av' }, typeIcon(t.type)),
    el('div', { style: 'min-width:0' },
      el('div', { class: 't1' }, t.note || t.sub || t.parent || t.type),
      el('div', { class: 't2' }, sub)),
    el('div', { class: 'amt ' + (isIn ? 'in' : 'out') },
      (isIn ? '+' : '−') + money(amt, t.currency),
      t.currency === 'SAR'
        ? el('span', { class: 'sub' }, '≈ ' + money((+amt || 0) * (t.fx || C.fxFor(t.date)), 'INR', false))
        : null),
    // A mouse cannot swipe. On anything with a pointer the same two actions
    // appear on hover instead.
    el('div', { class: 'tx-acts' },
      el('button', { class: 'icon-btn', title: 'Duplicate to today',
        onclick: e => { e.stopPropagation(); duplicate([t]); } }, '⧉'),
      el('button', { class: 'icon-btn', title: 'Delete', onclick: async e => {
        e.stopPropagation();
        if (await confirmBox('Delete this transaction?')) { await remove('transactions', t.id); toast('Deleted'); draw(); }
      } }, '🗑')));

  // Behind the row: duplicate and delete, revealed by swiping left.
  const behind = el('div', { class: 'tx-behind' },
    el('button', { class: 'dup', title: 'Duplicate to today', onclick: e => { e.stopPropagation(); duplicate([t]); } }, '＋'),
    el('button', {
      class: 'del', title: 'Delete', onclick: async e => {
        e.stopPropagation();
        if (await confirmBox('Delete this transaction?')) { await remove('transactions', t.id); toast('Deleted'); draw(); }
      },
    }, '🗑'));

  const slot = el('div', { class: 'tx-slot' }, behind, row);
  const toggle = () => { picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id); draw(); };

  row.addEventListener('click', () => {
    if (picking) { toggle(); return; }
    if (row.classList.contains('slid')) { row.classList.remove('slid'); return; }
    openTxEditor(t);
  });

  // Long press starts multi-select; a leftward drag reveals the row's actions.
  let timer = null, sx = 0, sy = 0, moved = false;
  const start = e => {
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY; moved = false;
    timer = setTimeout(() => {
      if (moved || picking) return;
      if (navigator.vibrate) navigator.vibrate(12);
      startPicking(t.id);
    }, 500);
  };
  const move = e => {
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - sx, dy = p.clientY - sy;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { moved = true; clearTimeout(timer); }
    if (!picking && Math.abs(dx) > Math.abs(dy) + 6) row.classList.toggle('slid', dx < -40);
  };
  const end = () => clearTimeout(timer);
  row.addEventListener('touchstart', start, { passive: true });
  row.addEventListener('touchmove', move, { passive: true });
  row.addEventListener('touchend', end);
  row.addEventListener('mousedown', start);
  row.addEventListener('mouseup', end);
  row.addEventListener('mouseleave', end);
  row.addEventListener('contextmenu', e => { e.preventDefault(); startPicking(t.id); });

  return slot;
}

function exportCSV(rows) {
  const head = ['No', 'Date', 'Time', 'Type', 'Account', 'Currency', 'Income', 'Expense',
    'Parent Category', 'Sub Category', 'Payee', 'Event', 'Description', 'FX Rate', 'Income INR', 'Expense INR'];
  const body = rows.slice().reverse().map(t => [t.no ?? '', t.date, t.time || '', t.type, t.account, t.currency,
    t.income || 0, t.expense || 0, t.parent || '', t.sub || '', t.payee || '', t.event || '', t.note || '',
    t.fx || '', C.inrOf(t).toFixed(2), C.inrOut(t).toFixed(2)]);
  downloadCSV(`jinnyfin-transactions-${todayISO()}.csv`, [head, ...body]);
}
