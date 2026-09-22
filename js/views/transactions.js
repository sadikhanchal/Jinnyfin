// ============================================================================
//  transactions.js — the full ledger: search, filter, duplicate, edit, export.
// ============================================================================
import { el, money, fmtDate, MONTHS, debounce, downloadCSV, todayISO, toast, confirmBox, uuid,
  dateGuard, dateBox, searchSelect } from '../util.js';
import { DB, putMany, remove } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { openTxEditor, typeIcon } from './editor.js';
import { icon } from '../icons.js';

const PAGE = 150;
const blank = () => ({ text: '', type: 'All', account: 'All', parent: 'All', payee: 'All',
                       year: 'All', month: 'All', from: '', to: '' });
let f = blank();
let shown = PAGE, host = null;
let chrome = null, results = null;   // the bar that stays, and the pane that is rebuilt
let picking = false;            // multi-select mode
const picked = new Set();       // ids chosen while picking
// How long a mouse button must be held before it counts as a long press
// rather than a click. Judged at the release, never by a timer.
const LONG_PRESS_MS = 550;
let suppressClick = false;      // a long press ends in a click; ignore that one

// Selection is a mode, not a setting: arriving at this screen always starts
// clean, and there is exactly one way out of it that also clears the ticks.
let pickPushed = false;

export async function render(root) {
  host = root;
  picking = false; picked.clear(); pickPushed = false;
  // The last unlinked transfer was fixed since this filter was chosen: the
  // option no longer exists, so arriving here must not leave it in force.
  if (f.type === C.UNLINKED && !C.unlinkedCount()) f.type = 'All';
  mount();
}
/**
 * New data arrived. The pickers list years, accounts and payees that the data
 * decides, so the bar has to be rebuilt — unless somebody is working in it,
 * in which case rebuilding it is exactly the thing that must not happen.
 */
export function refresh() {
  if (!host) return;
  const busy = chrome && [chrome.bar, chrome.search, chrome.filters]
    .some(n => n.contains(document.activeElement));
  busy ? draw() : mount();
}

// Escape leaves selection mode, the way it closes anything else in the app.
// There was no way out from the keyboard at all — you had to find "Done".
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !picking) return;
  if (!host || !host.isConnected) return;
  if (document.querySelector('.modal-wrap')) return;   // a sheet owns Esc first
  e.preventDefault();
  stopPicking();
});

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
function copyOf(t, seq, transferGroup = null) {
  const date = todayISO();
  return {
    ...t, id: uuid(), date, time: new Date().toTimeString().slice(0, 5),
    fx: C.fxFor(date), no: seq, transfer_group: transferGroup, updated_at: undefined,
  };
}

async function duplicate(rows) {
  if (!rows.length) return;
  let seq = Math.max(0, ...DB.transactions.map(x => x.no || 0));
  const transferLegs = new Map();

  // A transfer is one logical entry represented by two physical rows. Validate
  // every selected transfer before writing anything, so a mixed selection cannot
  // copy ordinary rows and then stop halfway on a broken transfer.
  for (const t of rows) {
    if (t.type !== 'Transfer') continue;
    if (!t.transfer_group) {
      toast('This transfer is not linked to its other half — fix that before copying it', 'warn', 5000);
      return;
    }
    if (!transferLegs.has(t.transfer_group)) {
      const legs = DB.transactions.filter(x => x.transfer_group === t.transfer_group && !x.deleted);
      if (legs.length < 2) {
        toast('This transfer is missing its other half — fix that before copying it', 'warn', 5000);
        return;
      }
      transferLegs.set(t.transfer_group, legs);
    }
  }

  const copiedGroups = new Set();
  const copies = [];
  for (const t of rows) {
    if (t.type === 'Transfer') {
      if (copiedGroups.has(t.transfer_group)) continue;
      copiedGroups.add(t.transfer_group);
      const group = uuid();
      for (const leg of transferLegs.get(t.transfer_group))
        copies.push(copyOf(leg, ++seq, group));
    } else {
      copies.push(copyOf(t, ++seq));
    }
  }

  await putMany('transactions', copies);
  const ids = copies.map(c => c.id);
  toast(`${copies.length} copied to today`, 'ok', 6000, {
    label: 'Undo',
    run: async () => { for (const id of ids) await remove('transactions', id); toast('Undone'); },
  });
  stopPicking();
}

// ------------------------------------------------------------------ view ---
/**
 * The bar of controls is built ONCE and then left alone.
 *
 * Everything above the results — the search box, the pickers, the two date
 * boxes — used to be thrown away and rebuilt on every keystroke. That is what
 * put the caret back on the first segment of a date, and what threw the cursor
 * out of the search box and into the To date. A date field has no way to say
 * "put the caret back on the middle part", so the only answer is that the box
 * must never be replaced while somebody is using it. Only the list below is
 * rebuilt now, which is the only part the filters actually change.
 */
function mount() {
  host.innerHTML = '';
  chrome = buildChrome();
  results = el('div', { class: 'tx-results' });
  host.append(chrome.bar, chrome.search, chrome.filters, results);
  draw();
}

function buildChrome() {
  const bar = topbar('Transactions',
    el('button', { class: 'btn sm' + (picking ? ' primary' : ''),
      onclick: () => (picking ? stopPicking() : startPicking(null)) }, picking ? 'Done' : '\u2713 Select'),
    el('button', { class: 'btn sm', onclick: () => exportCSV(rows) }, '⬇ CSV'),
    el('button', { class: 'btn sm primary', onclick: () => openTxEditor() }, '+ Add'));

  // ------------------------------------------------------------ search ----
  // The box now survives the redraw, so there is nothing to put the cursor
  // back into — and nothing to steal it from the date box either.
  const search = el('input', { type: 'search', value: f.text,
    placeholder: 'Search description, category, payee, amount…', enterkeyhint: 'search' });
  const clearBtn = el('button', { class: 'icon-btn clear', hidden: !f.text,
    onclick: () => { f.text = ''; search.value = ''; clearBtn.hidden = true; shown = PAGE; draw(); } }, '✕');
  search.addEventListener('input', debounce(() => {
    f.text = search.value; clearBtn.hidden = !f.text; shown = PAGE; draw();
  }, 280));
  const searchBar = el('div', { class: 'searchbar' },
    el('span', { class: 'mag' }, icon('search', 16)), search, clearBtn);

  // ----------------------------------------------------------- filters ----
  const sel = (label, key, options) => {
    const s = el('select', {}, el('option', { value: 'All' }, 'All'),
      ...options.map(o => el('option', { value: o.v ?? o, selected: String(f[key]) === String(o.v ?? o) }, o.t ?? o)));
    // The bar is never rebuilt, so there is no cursor to hand back afterwards —
    // and a hand-back request left lying here used to fire on the NEXT screen.
    s.dataset.fk = key;
    s.addEventListener('change', () => { f[key] = s.value; shown = PAGE; draw(); });
    return el('div', { class: 'field' }, el('label', {}, label), s);
  };
  /**
   * A date box that lets you finish typing the year — and finish retyping
   * the day, which forms just as complete-looking a date on its own first
   * keystroke once month and year are already filled. dateGuard covers both.
   */
  const dateIn = (label, key) => {
    const i = dateGuard(dateBox({ value: f[key] || '' }), v => {
      if (v === (f[key] || '')) return;
      f[key] = v; shown = PAGE; draw();
    }, key);
    return el('div', { class: 'field' }, el('label', {}, label), i);
  };
  /**
   * Account, Category and Payee run to dozens of names, and a plain select
   * only jumps on the FIRST letter typed. These are the same search box as the
   * reports and the transaction sheet: any word in the name finds it, and Tab,
   * Enter and Escape behave the same everywhere (see searchSelect).
   */
  const pick = (label, key, names, allLabel) => {
    const list = [{ value: 'All', search: allLabel, label: allLabel },
      ...names.map(n => ({ value: n, search: n, label: n }))];
    // A filter in force stays in its own list, or the box would read blank.
    if (f[key] !== 'All' && !names.includes(f[key])) list.push({ value: f[key], search: f[key], label: f[key] });
    const box = searchSelect(list, { placeholder: allLabel });
    box.dataset.fk = key;
    box.value = f[key];
    box.addEventListener('change', () => { f[key] = box.value; shown = PAGE; draw(); });
    return el('div', { class: 'field' }, el('label', {}, label), box);
  };
  const filters = el('div', { class: 'filters' },
    // "Half transfers" is a clean-up aid, listed only while there is
    // something to clean up (and while it is the filter in force, so the box
    // does not go blank the moment the last one is fixed).
    sel('Type', 'type', C.unlinkedCount() || f.type === C.UNLINKED ? [...C.TYPES, C.UNLINKED] : C.TYPES),
    pick('Account', 'account', C.accountNames(), 'All accounts'),
    pick('Category', 'parent', C.parentsFor(null), 'All categories'),
    pick('Payee', 'payee', C.payeeNames(), 'All payees'),
    sel('Year', 'year', C.yearsPresent()),
    sel('Month', 'month', MONTHS.map((m, i) => ({ v: i + 1, t: m }))),
    dateIn('From', 'from'), dateIn('To', 'to'),
    el('div', { class: 'field' }, el('label', {}, ' '),
      el('button', { class: 'btn sm', onclick: () => { f = blank(); mount(); } }, 'Clear')));

  return { bar, search: searchBar, filters };
}

function draw() {
  const keepScroll = window.scrollY;
  const rows = C.filterTx(f).slice().reverse();
  results.innerHTML = '';
  const host = results;                 // everything below lands in the results pane

  // The Select button lives in the bar, which is not rebuilt — so its label
  // has to be kept in step by hand.
  const selBtn = chrome.bar.querySelector('button');
  if (selBtn) { selBtn.textContent = picking ? 'Done' : '\u2713 Select'; selBtn.classList.toggle('primary', picking); }

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
    el('div', { class: 'big' }, icon('search', 40)), el('p', {}, 'Nothing matches those filters.')));

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
  // Nothing to hand the cursor back to: the boxes it could be in were never
  // taken away.
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
      } }, icon('trash', 16))));

  // Behind the row: duplicate and delete, revealed by swiping left.
  const behind = el('div', { class: 'tx-behind' },
    el('button', { class: 'dup', title: 'Duplicate to today', onclick: e => { e.stopPropagation(); duplicate([t]); } }, '＋'),
    el('button', {
      class: 'del', title: 'Delete', onclick: async e => {
        e.stopPropagation();
        if (await confirmBox('Delete this transaction?')) { await remove('transactions', t.id); toast('Deleted'); draw(); }
      },
    }, icon('trash', 16)));

  const slot = el('div', { class: 'tx-slot' }, behind, row);
  const toggle = () => { picked.has(t.id) ? picked.delete(t.id) : picked.add(t.id); draw(); };

  row.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }   // that was a long press
    if (picking) { toggle(); return; }
    if (row.classList.contains('slid')) { row.classList.remove('slid'); return; }
    openTxEditor(t);
  });

  // ------------------------------------------------------- long press ----
  // A finger and a mouse need different rules for the same gesture.
  //
  // A FINGER gets a timer: hold still for half a second and the row is picked,
  // with a buzz to say so — you find out while your finger is still down,
  // which is what makes it feel like a long press.
  //
  // A MOUSE is judged at the moment the button comes back up, by how long it
  // was held. A timer was wrong here: half a second is no time at all with a
  // mouse, so resting on the button while reading a row dropped the screen
  // into selection mode before the click had even finished. Deciding at the
  // release means one press does exactly one thing — a quick click opens the
  // row, a deliberate hold picks it — and never both.
  let timer = null, sx = 0, sy = 0, moved = false, downAt = 0;

  const touchStart = e => {
    const p = e.touches[0];
    sx = p.clientX; sy = p.clientY; moved = false;
    timer = setTimeout(() => {
      if (moved || picking) return;
      if (navigator.vibrate) navigator.vibrate(12);
      startPicking(t.id);
    }, 500);
  };
  const touchMove = e => {
    const p = e.touches[0];
    const dx = p.clientX - sx, dy = p.clientY - sy;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { moved = true; clearTimeout(timer); }
    if (!picking && Math.abs(dx) > Math.abs(dy) + 6) row.classList.toggle('slid', dx < -40);
  };
  row.addEventListener('touchstart', touchStart, { passive: true });
  row.addEventListener('touchmove', touchMove, { passive: true });
  row.addEventListener('touchend', () => clearTimeout(timer));
  row.addEventListener('touchcancel', () => clearTimeout(timer));

  row.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    downAt = Date.now(); sx = e.clientX; sy = e.clientY; moved = false;
  });
  row.addEventListener('mousemove', e => {
    if (!downAt) return;
    if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) moved = true;
  });
  row.addEventListener('mouseleave', () => { downAt = 0; });
  row.addEventListener('mouseup', e => {
    if (e.button !== 0 || !downAt) return;
    const held = Date.now() - downAt;
    downAt = 0;
    if (held < LONG_PRESS_MS || moved || picking) return;   // an ordinary click
    suppressClick = true;        // the click that follows this is not a click
    startPicking(t.id);
  });

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
