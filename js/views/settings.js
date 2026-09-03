// ============================================================================
//  settings.js — accounts, categories, FX rates, reconciliation, backup, import.
// ============================================================================
import { el, money, num, fmtDate, todayISO, modal, toast, confirmBox, downloadCSV, downloadFile, monthStart, MONTHS } from '../util.js';
import { DB, put, remove, putMany, getSettings, setSettings, sync, state, resetLocal, signOut,
  changePassword, sendPasswordReset, TABLES } from '../store.js';
import { store as safeStore } from '../util.js';
import * as C from '../calc.js';
import { round2 } from '../util.js';
import { hashPin } from '../crypto.js';
import { topbar, toggleTheme, BUILD, askSignOut } from '../app.js';
import { kpi } from './report.js';
import { openTxEditor } from './editor.js';

let tab = 'general', host = null;
let showInactive = false;      // closed accounts stay out of the way by default
let asOf = null;               // reconcile up to this date (null = today)
const TABS = [['general', 'General'], ['accounts', 'Accounts'], ['categories', 'Categories'],
  ['fx', 'Exchange rates'], ['reconcile', 'Reconcile'], ['check', 'Data check'],
  ['data', 'Backup & import']];

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  host.innerHTML = '';
  host.append(topbar('Settings'));
  const odd = checkCount();
  host.append(el('div', { class: 'seg', style: 'margin-bottom:14px;flex-wrap:wrap' },
    TABS.map(([k, t]) => el('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } },
      t, k === 'check' && odd ? el('span', { class: 'tab-badge' }, String(odd)) : null))));
  ({ general, accounts, categories, fx, reconcile, check, data })[tab]();
}

// ------------------------------------------------------------------ general
function general() {
  const s = getSettings();
  const sar = el('input', { type: 'number', step: '0.0001', value: C.rates().sar });
  const usd = el('input', { type: 'number', step: '0.0001', value: C.rates().usd });
  const invCats = el('input', { value: (s.investment_categories || C.investmentCategories()).join(', '), style: 'width:100%' });

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Today’s conversion rates')),
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, '1 SAR = ? INR'), sar),
      el('div', { class: 'field' }, el('label', {}, '1 USD = ? SAR'), usd),
      el('div', { class: 'field full' },
        el('button', { class: 'btn primary', onclick: async () => {
          await setSettings({ sar_to_inr: +sar.value, usd_to_sar: +usd.value });
          toast('Rates updated'); draw();
        } }, 'Save rates'),
        el('p', { class: 'hint' }, 'These convert current balances. Past transactions keep the rate of the month they happened in — that is what makes the historical totals match your sheet.')))));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Investment categories')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'Holdings tracked by category rather than by account (deposits + returns − withdrawals). Comma separated.'),
    invCats,
    el('button', { class: 'btn', style: 'margin-top:8px', onclick: async () => {
      await setSettings({ investment_categories: invCats.value.split(',').map(x => x.trim()).filter(Boolean) });
      toast('Saved');
    } }, 'Save')));

  // ------------------------------------------------------------ app lock --
  const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'New PIN (4+ digits)' });
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'App lock')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      s.lock_hash ? 'A PIN is set — the app asks for it each time it is opened fresh.' : 'No PIN. Anyone holding your unlocked phone can read the ledger.'),
    el('div', { class: 'row' }, pin,
      el('button', { class: 'btn primary', onclick: async () => {
        if (pin.value.length < 4) return toast('At least 4 characters', 'warn');
        const h = await hashPin(pin.value);
        await setSettings({ lock_hash: h.hash, lock_salt: h.salt });
        safeStore('jinnyfin-unlocked', '1', 'session');
        toast('App lock on'); pin.value = ''; draw();
      } }, 'Set PIN'),
      s.lock_hash ? el('button', { class: 'btn ghost', onclick: async () => {
        if (await confirmBox('Turn the app lock off?')) { await setSettings({ lock_hash: null, lock_salt: null }); toast('Lock removed'); draw(); }
      } }, 'Remove') : null)));

  // -------------------------------------------------------- your details --
  const owner = el('input', { value: s.owner_name || '', placeholder: 'Name shown on statements' });
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Your name')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'Printed at the top of the statements you hand to people you lend to or borrow from.'),
    el('div', { class: 'row' }, owner,
      el('button', { class: 'btn primary', onclick: async () => {
        await setSettings({ owner_name: owner.value.trim() }); toast('Saved');
      } }, 'Save'))));

  // ------------------------------------------------------------ password --
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Sign-in password')), passwordBlock()));

  // ------------------------------------------------------------- account --
  // ------------------------------------------------- storage & offline ---
  const health = el('div', { class: 'small' }, el('span', { class: 'muted' }, 'Checking\u2026'));
  storageReport().then(rows => {
    health.innerHTML = '';
    for (const r of rows) {
      health.append(el('div', { class: 'row', style: 'gap:8px;padding:3px 0;align-items:baseline' },
        el('span', { style: 'width:16px' }, r.ok ? '\u2705' : '\u26d4'),
        el('b', { style: 'min-width:132px' }, r.label),
        el('span', { class: r.ok ? 'muted' : '' , style: r.ok ? '' : 'color:var(--critical)' }, r.detail)));
    }
    const bad = rows.filter(r => !r.ok);
    health.append(el('p', { class: 'small muted', style: 'margin:10px 0 0' }, bad.length
      ? 'A \u26d4 above is why the app forgets your sign-in and will not open without internet: '
        + 'this browser is refusing to keep anything on the device. '
        + 'Chrome \u22ee \u2192 Settings \u2192 Site settings \u2192 Cookies and site data \u2192 allow this site. '
        + 'Also check that \u201cDelete cookies when you close all tabs\u201d is off.'
      : 'All good \u2014 this device keeps its own copy, so the app opens with no internet '
        + 'and only asks for your PIN.'));
  });
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Storage & offline')), health));

  // ------------------------------------------------------------- version --
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'App version')),
    el('p', { class: 'small', style: 'margin:0 0 8px' },
      el('b', {}, `${BUILD.version} \u00b7 ${BUILD.date}`),
      el('span', { class: 'muted' }, '  \u2014 compare this with the version I sent you.')),
    el('p', { class: 'small muted', style: 'margin:0 0 10px' },
      'If it is behind, this device is holding an old copy. The button below throws that copy '
      + 'away and re-downloads everything. Your data is untouched \u2014 it lives on the server and in the ledger.'),
    el('button', { class: 'btn primary', onclick: forceUpdate }, '\u21bb Force update')));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'This device')),
    el('div', { class: 'grid g2' },
      el('div', {}, el('p', { class: 'small' }, el('b', {}, 'Signed in: '), state.user?.email || '—'),
        el('p', { class: 'small' }, el('b', {}, 'Last sync: '), state.lastSync ? new Date(state.lastSync).toLocaleString() : 'never'),
        el('p', { class: 'small' }, el('b', {}, 'Waiting to upload: '), String(state.pending)),
        el('p', { class: 'small' }, el('b', {}, 'Transactions held locally: '), DB.transactions.length.toLocaleString('en-IN'))),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => sync().then(() => toast('Synced')) }, '↻ Sync now'),
        el('button', { class: 'btn', onclick: toggleTheme }, '◑ Theme'),
        el('button', { class: 'btn ghost', onclick: askSignOut }, 'Sign out')))));
}

/** Change the Supabase password, or mail a reset link when it is forgotten. */
function passwordBlock() {
  const cur = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const nw = el('input', { type: 'password', placeholder: 'New password (6+)', autocomplete: 'new-password' });
  const rep = el('input', { type: 'password', placeholder: 'New password again', autocomplete: 'new-password' });
  const msg = el('p', { class: 'small', style: 'min-height:18px;margin:6px 0 0' });
  const btn = el('button', { class: 'btn primary' }, 'Change password');
  btn.onclick = async () => {
    msg.textContent = ''; msg.style.color = 'var(--critical)';
    if (nw.value.length < 6) return (msg.textContent = 'New password needs at least 6 characters.');
    if (nw.value !== rep.value) return (msg.textContent = 'The two new passwords do not match.');
    if (nw.value === cur.value) return (msg.textContent = 'That is the same password you have now.');
    btn.disabled = true; btn.textContent = 'Changing…';
    try {
      await changePassword(cur.value, nw.value);
      cur.value = nw.value = rep.value = '';
      msg.style.color = 'var(--good-text)';
      msg.textContent = 'Done. Your other devices stay signed in.';
      toast('Password changed');
    } catch (e) {
      msg.textContent = e.message || 'Could not change the password.';
    }
    btn.disabled = false; btn.textContent = 'Change password';
  };
  const fld = (l, n) => el('div', { class: 'field' }, el('label', {}, l), n);
  return el('div', {},
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'This is the password you sign in with on every device — not the app PIN above.'),
    el('div', { class: 'form-grid' },
      fld('Current password', cur), fld('New password', nw), fld('Repeat new password', rep)),
    el('div', { class: 'row', style: 'margin-top:10px' }, btn,
      el('button', { class: 'btn ghost', onclick: async () => {
        const mail = state.user?.email;
        if (!mail) return toast('Not signed in', 'warn');
        try { await sendPasswordReset(mail); toast('Reset link sent to ' + mail, 'ok', 5000); }
        catch (e) { toast(e.message || 'Could not send the link', 'warn', 4000); }
      } }, 'Email me a reset link')),
    msg);
}

/**
 * What this device will and will not keep. Every "it forgot my login" and
 * "it will not open offline" report traces back to one of these five lines,
 * so the app answers it itself instead of guessing over chat.
 */
async function storageReport() {
  const rows = [];
  const probe = (label, fn) => { try { return { label, ...fn() }; }
    catch (e) { return { label, ok: false, detail: 'blocked by the browser' }; } };

  rows.push({ label: 'Local database', ok: !state.storageError,
    detail: state.storageError ? state.storageError
      : `${DB.transactions.length.toLocaleString('en-IN')} transactions held here` });

  rows.push(probe('Small settings', () => {
    localStorage.setItem('__jf', '1'); localStorage.removeItem('__jf');
    return { ok: true, detail: 'working' };
  }));

  let sw = { ok: false, detail: 'not registered' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) sw = { ok: true, detail: reg.active ? 'active' : 'installing' };
  } catch { sw = { ok: false, detail: 'unavailable' }; }
  rows.push({ label: 'Offline engine', ...sw });

  let files = { ok: false, detail: 'nothing cached \u2014 the app needs internet to open' };
  try {
    const keys = await caches.keys();
    let n = 0, name = '';
    for (const k of keys) { const c = await caches.open(k); n += (await c.keys()).length; name = k; }
    files = n ? { ok: true, detail: `${n} files ready (${name})` } : files;
  } catch { files = { ok: false, detail: 'cache storage blocked' }; }
  rows.push({ label: 'Offline files', ...files });

  try {
    const q = await navigator.storage?.estimate?.();
    if (q) rows.push({ label: 'Space used', ok: true,
      detail: `${(q.usage / 1048576).toFixed(1)} MB of ${(q.quota / 1048576).toFixed(0)} MB` });
  } catch { /* not offered on every browser */ }

  rows.push({ label: 'Signed in as', ok: !!state.user, detail: state.user?.email || 'not signed in' });
  return rows;
}

/**
 * Unregister the service worker, drop every cache, reload past the browser's
 * own cache. The one reliable cure for "I uploaded it but nothing changed".
 */
async function forceUpdate() {
  if (!(await confirmBox('Throw away this device\u2019s copy of the app and download it again? '
      + 'Your transactions are not touched.', 'Yes, update'))) return;
  toast('Updating\u2026', 'ok', 6000);
  const jobs = [];
  if (window.caches?.keys) {
    jobs.push(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
  }
  if (navigator.serviceWorker?.getRegistrations) {
    jobs.push(navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
  }
  const done = () => location.replace(location.pathname + '?fresh=' + Date.now() + location.hash);
  Promise.all(jobs).then(done, done);
  setTimeout(done, 4000);
}

// ----------------------------------------------------------------- accounts
function accounts() {
  const bals = C.allAccountBalances();
  const seen = C.lastActivity();
  const st = a => C.accountStatus(a, seen);
  const all = [...DB.accounts].sort((x, y) => (x.grp || '').localeCompare(y.grp || '') || x.name.localeCompare(y.name));
  const dead = all.filter(a => !st(a).live).length;
  const list = showInactive ? all : all.filter(a => st(a).live);
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Account'), el('th', {}, 'Currency'), el('th', {}, 'Group'),
    el('th', { class: 'n' }, 'Balance'), el('th', { class: 'n' }, 'Entries'), el('th', {}, 'Shown?'))));
  const tb = el('tbody');
  for (const a of list) {
    const n = DB.transactions.filter(t2 => t2.account === a.name).length;
    const s2 = st(a);
    tb.append(el('tr', { class: s2.live ? '' : 'muted', style: 'cursor:pointer', onclick: () => editAccount(a) },
      el('td', {}, a.name), el('td', {}, a.currency), el('td', { class: 'muted small' }, a.grp),
      el('td', { class: 'n' }, money(bals.get(a.name) || 0, a.currency)),
      el('td', { class: 'n muted' }, n),
      el('td', { class: 'small', title: s2.why }, s2.live ? '✓ ' + (a.pinned ? 'pinned' : 'in use') : '— ' + s2.why)));
  }
  t.append(tb);

  const toggle = el('label', { class: 'chip', style: 'cursor:pointer' },
    el('input', { type: 'checkbox', checked: showInactive,
      onchange: e => { showInactive = e.target.checked; draw(); } }),
    ` show idle accounts (${dead})`);

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', {}, `Accounts (${list.length}${showInactive ? '' : ` of ${all.length}`})`),
      el('div', { class: 'spacer' }), toggle,
      el('button', { class: 'btn sm primary', onclick: () => editAccount() }, '+ Account')),
    el('div', { class: 'table-wrap', style: 'max-height:70vh;overflow:auto' }, t)));
}

function editAccount(a = null) {
  const v = a || { name: '', currency: 'SAR', grp: 'primary', opening_bal: 0, active: true, stated_balance: null };
  const name = el('input', { value: v.name });
  const cur = el('select', {}, ...['SAR', 'INR', 'USD'].map(c => el('option', { value: c, selected: v.currency === c }, c)));
  const grp = el('select', {}, ...[['primary', 'Cash & bank'], ['investment', 'Investment'], ['other', 'Closed / other']]
    .map(([k, t]) => el('option', { value: k, selected: v.grp === k }, t)));
  const ob = el('input', { type: 'number', step: 'any', value: v.opening_bal || 0 });
  const stated = el('input', { type: 'number', step: 'any', value: v.stated_balance ?? '' , placeholder: 'from your bank app' });
  const act = el('input', { type: 'checkbox', checked: !!v.pinned });
  const fld = (l, n, cls = '', h) => el('div', { class: 'field ' + cls }, el('label', {}, l), n, h ? el('span', { class: 'hint' }, h) : null);
  const body = el('div', { class: 'form-grid' },
    fld('Name', name, 'full'), fld('Currency', cur), fld('Group', grp),
    fld('Opening balance', ob, '', 'Only if the ledger does not already carry it.'),
    fld('Bank says', stated, '', 'Used by the Reconcile tab to spot differences.'),
    el('label', { class: 'field full row', style: 'flex-direction:row;gap:8px;align-items:center' }, act,
      ' Always show \u2014 keep this account in the pickers even if it goes quiet'),
    el('p', { class: 'hint full', style: 'margin:0' },
      'Left off, an account shows while it has been used in the last 60 days. '
      + 'A new account is always shown for its first 60 days.'));
  const m = modal(a ? 'Edit account' : 'New account', body, {
    footer: [
      a ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => {
          const n = DB.transactions.filter(t => t.account === a.name).length;
          if (n) return toast(`${n} transactions use this account — set it inactive instead`, 'warn', 4000);
          if (await confirmBox('Delete this account?')) { await remove('accounts', a.id); m.close(); }
        } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return toast('Name?', 'warn');
        const oldName = a?.name;
        await put('accounts', { ...v, created_at: v.created_at || todayISO(),
          name: name.value.trim(), currency: cur.value, grp: grp.value,
          opening_bal: +ob.value || 0, stated_balance: stated.value === '' ? null : +stated.value, pinned: act.checked });
        if (oldName && oldName !== name.value.trim()) {
          const affected = DB.transactions.filter(t => t.account === oldName);
          if (affected.length && await confirmBox(`Rename this account on ${affected.length} existing transactions too?`))
            await putMany('transactions', affected.map(t => ({ ...t, account: name.value.trim() })));
        }
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}

// --------------------------------------------------------------- categories
/**
 * Lend/Borrow only ever means four things. Years of the workbook left the same
 * movement filed four different ways (a bare "Repayment" parent, a sub that
 * contradicts its own direction). This folds them onto the two categories and
 * their two subs each — the direction of the money decides, so no balance moves.
 */
const LB_MAP = t => {
  const isIn = (+t.income || 0) > 0;
  if (t.parent === 'Lend' || t.parent === 'Collecting debts')
    return { parent: 'Lend', sub: isIn ? 'Collecting debts' : 'Lend' };
  if (t.parent === 'Borrow' || t.parent === 'Repayment')
    return { parent: 'Borrow', sub: isIn ? 'Borrow' : 'Repayment' };
  return null;
};
const lbStrays = () => DB.transactions.filter(t => {
  if (t.type !== 'Lend/Borrow') return false;
  const w = LB_MAP(t);
  return w && (w.parent !== t.parent || w.sub !== t.sub);
});

async function tidyLendBorrow() {
  const bad = lbStrays();
  if (!bad.length) return toast('Already tidy');
  if (!(await confirmBox(
    `Re-file ${bad.length.toLocaleString('en-IN')} Lend/Borrow entries onto Lend (Lend · Collecting debts) `
    + 'and Borrow (Borrow · Repayment)? No amount and no balance changes — only the labels.'))) return;
  await putMany('transactions', bad.map(t => ({ ...t, ...LB_MAP(t) })));

  // The old parents ("Repayment", "Collecting debts") now have nothing under them.
  const keep = new Set(['Lend|Lend', 'Lend|Collecting debts', 'Borrow|Borrow', 'Borrow|Repayment']);
  const junk = DB.categories.filter(c => c.type === 'Lend/Borrow' && !keep.has(`${c.parent}|${c.sub}`));
  for (const c of junk) await remove('categories', c.id);
  for (const k of keep) {
    const [parent, sub] = k.split('|');
    if (!DB.categories.some(c => c.type === 'Lend/Borrow' && c.parent === parent && c.sub === sub))
      await put('categories', { type: 'Lend/Borrow', parent, sub });
  }
  toast(`${bad.length} entries re-filed`); draw();
}

function categories() {
  const strays = lbStrays().length;
  if (strays) {
    host.append(el('div', { class: 'alert slim', style: 'margin-bottom:12px' },
      el('span', { class: 'ico' }, '⚠'),
      el('div', {}, `${strays.toLocaleString('en-IN')} Lend / Borrow entries sit under old labels — `,
        el('a', { href: '#', onclick: e => { e.preventDefault(); tab = 'check'; draw(); } }, 'see them in Data check'))));
  }

  const byType = {};
  for (const c of DB.categories) {
    if (!byType[c.type]) byType[c.type] = {};
    byType[c.type][c.parent] = [...(byType[c.type][c.parent] || []), c];
  }
  host.append(el('div', { class: 'row', style: 'margin-bottom:10px' },
    el('button', { class: 'btn sm primary', onclick: () => editCat() }, '+ Category')));
  for (const [type, parents] of Object.entries(byType)) {
    const card = el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, `${type} — ${Object.keys(parents).length} categories`)));
    for (const [parent, list] of Object.entries(parents).sort()) {
      const subs = list.filter(c => c.sub);
      card.append(el('div', { style: 'padding:7px 0;border-bottom:1px solid var(--grid)' },
        el('div', { class: 'row' }, el('b', {}, parent), el('div', { class: 'spacer' }),
          el('span', { class: 'small muted' }, DB.transactions.filter(t => t.parent === parent).length + ' entries'),
          el('button', { class: 'icon-btn', onclick: () => editCat({ type, parent, sub: null }) }, '+')),
        subs.length ? el('div', { class: 'pill-list', style: 'margin-top:5px' },
          subs.map(c => el('button', { class: 'chip', onclick: () => editCat(c) }, c.sub))) : null));
    }
    host.append(card);
  }
}

function editCat(c = null) {
  const v = c || { type: 'Expense', parent: '', sub: '' };
  const type = el('select', {}, ...['Expense', 'Income', 'Lend/Borrow', 'Investment'].map(t => el('option', { value: t, selected: v.type === t }, t)));
  const parent = el('input', { value: v.parent || '', list: 'dl-cp' });
  const sub = el('input', { value: v.sub || '' });
  const dl = el('datalist', { id: 'dl-cp' }); C.parentsFor(null).forEach(p => dl.append(el('option', { value: p })));
  const fld = (l, n) => el('div', { class: 'field full' }, el('label', {}, l), n);
  const m = modal(c?.id ? 'Edit category' : 'New category',
    el('div', { class: 'form-grid' }, fld('Type', type), fld('Category', parent), fld('Sub-category', sub), dl), {
    footer: [
      c?.id ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this category?')) { await remove('categories', c.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!parent.value.trim()) return toast('Category name?', 'warn');
        await put('categories', { ...v, type: type.value, parent: parent.value.trim(), sub: sub.value.trim() || null });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------------- rates
function fx() {
  const add = el('div', { class: 'row', style: 'margin-bottom:10px' });
  const mIn = el('input', { type: 'month', value: todayISO().slice(0, 7) });
  const rIn = el('input', { type: 'number', step: '0.0001', placeholder: '25.2390' });
  add.append(mIn, rIn, el('button', { class: 'btn primary', onclick: async () => {
    if (!mIn.value || !rIn.value) return toast('Month and rate', 'warn');
    const month = mIn.value + '-01';
    const found = DB.fx_rates.find(r => String(r.month).slice(0, 7) === mIn.value);
    await put('fx_rates', { ...(found || {}), month, rate: +rIn.value, source: 'Manual' });
    toast('Rate saved'); draw();
  } }, 'Save rate'));
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'SAR → INR by month')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'Each transaction is converted at the rate of its own month, exactly like the workbook. Add a rate whenever you transfer money and know the real rate you got.'),
    add));
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Month'), el('th', { class: 'n' }, 'SAR → INR'), el('th', {}, 'Source'), el('th', { class: 'n' }, 'Entries that month'))));
  const tb = el('tbody');
  for (const r of [...DB.fx_rates].sort((a, b) => (a.month < b.month ? 1 : -1))) {
    const key = String(r.month).slice(0, 7);
    tb.append(el('tr', {}, el('td', {}, key),
      el('td', { class: 'n' }, num(r.rate, 4)),
      el('td', { class: 'muted small' }, r.source || ''),
      el('td', { class: 'n muted' }, DB.transactions.filter(x => x.date.slice(0, 7) === key).length)));
  }
  t.append(tb);
  host.append(el('div', { class: 'card', style: 'margin-top:12px' }, el('div', { class: 'table-wrap', style: 'max-height:60vh;overflow:auto' }, t)));
}

// -------------------------------------------------------------- reconcile
/**
 * The workbook's balance check, made writable. Type what the bank app shows,
 * see the gap, add the missing entries, watch the gap go to zero.
 */
function reconcile() {
  const s = getSettings();
  const rows = C.reconciliation(asOf);
  const set = rows.filter(r => r.stated != null);
  const diffs = set.filter(r => Math.abs(r.diff) > 0.01);
  const totalDiff = diffs.reduce((n, r) => n + (r.currency === 'SAR' ? r.diff * C.rates().sar : r.diff), 0);

  const dateIn = el('input', { type: 'date', value: asOf || todayISO(), style: 'max-width:180px' });
  dateIn.onchange = () => { asOf = dateIn.value || null; draw(); };

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Balances & reconciliation'), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, 'As of'), dateIn),
    el('p', { class: 'small muted', style: 'margin:8px 0 0' },
      s.reconciled_at
        ? `Last reconciled ${fmtDate(s.reconciled_at)}. Balances above are computed up to the “as of” date.`
        : 'Type the balance your bank app shows into “Bank says”. Anything that does not match is a missing or wrong entry.')));

  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' },
    kpi('Accounts checked', `${set.length} / ${rows.length}`),
    kpi('Matching', String(set.length - diffs.length), 'income'),
    kpi('Off', String(diffs.length), diffs.length ? 'expense' : ''),
    kpi('Total difference ≈ INR', num(totalDiff), Math.abs(totalDiff) < 0.01 ? 'income' : 'expense')));

  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', { style: 'width:34px' }, ''),
    el('th', {}, 'Account'), el('th', { class: 'n' }, 'App says'),
    el('th', { class: 'n' }, 'Bank says'), el('th', { class: 'n' }, 'Difference'), el('th', {}, 'Checked'))));
  const tb = el('tbody');
  makeSortable(tb, order => saveOrder(order));
  for (const r of rows) {
    const inp = el('input', {
      type: 'number', step: 'any', class: 'inline-num', value: r.stated ?? '',
      placeholder: '—', inputmode: 'decimal',
    });
    // Saving on change (not on every keystroke) keeps the sync queue quiet.
    inp.onchange = async () => {
      const acct = DB.accounts.find(a => a.id === r.id);
      if (!acct) return;
      const v = inp.value.trim() === '' ? null : +inp.value;
      await put('accounts', { ...acct, stated_balance: v, reconciled_at: v == null ? null : (asOf || todayISO()) });
      draw();
    };
    const live = r.stated == null ? null : Math.round((r.computed - r.stated) * 100) / 100;
    tb.append(el('tr', { dataset: { id: r.id } },
      el('td', { class: 'drag-cell' }, el('span', { class: 'drag-grip', draggable: 'true', title: 'Drag to reorder' }, '\u283f')),
      el('td', {}, r.name),
      el('td', { class: 'n' }, money(r.computed, r.currency)),
      el('td', { class: 'n' }, inp),
      el('td', { class: 'n ' + (live == null ? '' : Math.abs(live) <= 0.01 ? 'pos' : 'neg') },
        live == null ? '–' : (Math.abs(live) <= 0.01 ? '✓ match' : num(live))),
      el('td', { class: 'small muted' }, r.checked ? fmtDate(r.checked) : '')));
  }
  t.append(tb);

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Balance check'), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted', style: 'margin-right:8px' }, 'drag ⠿ to reorder'),
      el('button', { class: 'btn sm', onclick: () => exportRecon(rows) }, '⬇ CSV'),
      el('button', { class: 'btn sm primary', onclick: async () => {
        const d = asOf || todayISO();
        await setSettings({ reconciled_at: d });
        toast('Reconciled as of ' + fmtDate(d));
        draw();
      } }, '✓ Mark reconciled')),
    el('div', { class: 'table-wrap' }, t),
    el('p', { class: 'hint', style: 'margin-top:10px' },
      'A positive difference means the app counts more than the bank does — usually an entry that never happened, '
      + 'or one entered twice. A negative difference means an entry is missing. Fix it in Transactions and this goes to zero.')));
}

function exportRecon(rows) {
  downloadCSV(`jinnyfin-reconcile-${asOf || todayISO()}.csv`,
    [['Account', 'Currency', 'App says', 'Bank says', 'Difference', 'Checked on'],
      ...rows.map(r => [r.name, r.currency, r.computed.toFixed(2),
        r.stated == null ? '' : r.stated.toFixed(2),
        r.diff == null ? '' : r.diff.toFixed(2), r.checked || ''])]);
}

/**
 * Drag-to-reorder for a table body. Works with a mouse and with a finger: HTML5
 * drag events never fire on touch, so a long-press-and-slide is handled too.
 */
function makeSortable(tbody, done) {
  let src = null;
  const rowOf = n => n?.closest?.('tr');
  const place = (over, y) => {
    if (!src || !over || over === src) return;
    const b = over.getBoundingClientRect();
    over.parentNode.insertBefore(src, y < b.top + b.height / 2 ? over : over.nextSibling);
  };
  const finish = () => {
    if (!src) return;
    src.classList.remove('dragging');
    src = null;
    done([...tbody.children].map(tr => tr.dataset.id).filter(Boolean));
  };

  tbody.addEventListener('dragstart', e => {
    if (!e.target.classList?.contains('drag-grip')) return e.preventDefault();
    src = rowOf(e.target); src.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', src.dataset.id); } catch { /* Safari */ }
  });
  tbody.addEventListener('dragover', e => { e.preventDefault(); place(rowOf(e.target), e.clientY); });
  tbody.addEventListener('drop', e => { e.preventDefault(); finish(); });
  tbody.addEventListener('dragend', finish);

  // touch: the grip starts it, the finger moves it
  tbody.addEventListener('touchstart', e => {
    if (!e.target.classList?.contains('drag-grip')) return;
    src = rowOf(e.target); src.classList.add('dragging');
  }, { passive: true });
  tbody.addEventListener('touchmove', e => {
    if (!src) return;
    e.preventDefault();
    const t = e.touches[0];
    place(rowOf(document.elementFromPoint(t.clientX, t.clientY)), t.clientY);
  }, { passive: false });
  tbody.addEventListener('touchend', finish);
}

/** Store the arrangement on the accounts themselves, so every list obeys it. */
async function saveOrder(ids) {
  const rows = [];
  ids.forEach((id, i) => {
    const a = DB.accounts.find(x => x.id === id);
    if (a && a.sort !== i) rows.push({ ...a, sort: i });
  });
  if (!rows.length) return;
  await putMany('accounts', rows);
  toast('Order saved');
}

// ------------------------------------------------------------ backup/import
function data() {
  const s = getSettings();
  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Backup')),
    el('p', { class: 'small muted' }, 'A full JSON snapshot of everything — restoreable into a fresh install.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: backup }, '⬇ Download backup'),
      el('button', { class: 'btn', onclick: () => exportAllCSV() }, '⬇ All transactions (CSV)'),
      el('button', { class: 'btn', onclick: () => document.getElementById('restore-file').click() }, '⬆ Restore from backup'),
      el('input', { type: 'file', id: 'restore-file', accept: '.json', style: 'display:none', onchange: restore }))));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Import from the Excel workbook')),
    el('p', { class: 'small muted' },
      'One-time load of everything from MISA Entry 06.xlsm — 25,074 transactions, accounts, categories, FX history, assets, policies and the equity portfolio.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: importSeed }, '⬇ Load workbook data'),
      s.seeded ? el('span', { class: 'chip' }, '✓ already imported on ' + fmtDate(s.seeded)) : null),
    el('p', { class: 'hint' }, 'Safe to run once. Running it twice would duplicate everything, so it asks first.')));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Danger zone')),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: async () => {
        if (await confirmBox('Clear this device’s local copy and download everything again from the server? Nothing on the server is touched.')) {
          await resetLocal(); await sync({ full: true }); toast('Re-downloaded'); draw();
        }
      } }, '↻ Rebuild local copy'),
      el('button', { class: 'btn danger', onclick: wipeAll }, '⚠ Delete everything'))));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Numbers check')),
    verifyBlock()));
}

function verifyBlock() {
  const nw = C.netWorth();
  const tot = C.periodTotals({});
  const rows = [
    ['Total income (all time, ≈ INR)', tot.incomeINR, 18793096.41],
    ['Total expenses (all time, ≈ INR)', tot.expenseINR, 16979321.29],
    ['Net savings', tot.netINR, 1813775.12],
    ['Cash & bank', nw.cash, 194375.33],
    ['Fixed assets', nw.assets, 9472896.24],
    ['Lend / borrow (net)', nw.lendBorrow, -380431.27],
  ];
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', {}, 'Figure'), el('th', { class: 'n' }, 'This app'),
    el('th', { class: 'n' }, 'The workbook'), el('th', { class: 'n' }, 'Difference'))));
  const tb = el('tbody');
  for (const [label, mine, sheet] of rows) {
    const d = mine - sheet;
    tb.append(el('tr', {}, el('td', {}, label), el('td', { class: 'n' }, num(mine)),
      el('td', { class: 'n muted' }, num(sheet)),
      el('td', { class: 'n ' + (Math.abs(d) < 1 ? 'pos' : 'neg') }, Math.abs(d) < 1 ? '✓ match' : num(d))));
  }
  t.append(tb);
  return el('div', {}, el('p', { class: 'small muted' },
    'Compared against MISA Entry 06.xlsm as of 31 Aug 2026. Investments differ by ₹36,278 on purpose — the workbook’s dashboard left the Geojit equity out of its investments total while its own Settings sheet included it; this app includes it.'),
    el('div', { class: 'table-wrap' }, t));
}

async function backup() {
  const out = { app: 'jinnyfin-finance', version: 1, exported: new Date().toISOString() };
  for (const t of TABLES) out[t] = DB[t];
  downloadFile(`jinnyfin-backup-${todayISO()}.json`, JSON.stringify(out), 'application/json');
  toast('Backup downloaded');
}

async function restore(e) {
  const file = e.target.files[0]; if (!file) return;
  if (!(await confirmBox('Merge this backup into the current data? Rows with the same id are overwritten.'))) return;
  const json = JSON.parse(await file.text());
  for (const t of TABLES) if (Array.isArray(json[t]) && json[t].length) await putMany(t, json[t]);
  await sync();
  toast('Backup restored'); draw();
}

// -------------------------------------------------------------- data check
/**
 * Everything the app has noticed but will not touch on its own. Each group is
 * a real list of entries, and every line opens the entry itself — so a wrong
 * row gets looked at and decided on, not silently rewritten underneath you.
 */

/** A row whose currency disagrees with the account it sits on. */
const currencyOdd = () => {
  const cur = new Map(DB.accounts.map(a => [a.name, a.currency]));
  return DB.transactions.filter(t => !t.deleted && cur.has(t.account) && cur.get(t.account) !== t.currency)
    .map(t => ({ t, why: `account is ${cur.get(t.account)}, this row says ${t.currency}` }));
};

/** A Lend/Borrow entry still filed under an old label from the workbook. */
const lbOdd = () => lbStrays().map(t => {
  const w = LB_MAP(t);
  return { t, why: `filed as ${[t.parent, t.sub].filter(Boolean).join(' · ') || 'nothing'} — should be ${w.parent} · ${w.sub}` };
});

/** An entry with no category at all, so it lands nowhere in a report. */
const noCategory = () => DB.transactions
  .filter(t => !t.deleted && !t.parent && t.type !== 'Transfer' && t.type !== 'Opening Balance')
  .map(t => ({ t, why: 'no category, so it is missing from every breakdown' }));

const SHOW = 60;                       // enough to work through, not a wall of rows

function checkGroup(host2, title, blurb, rows, extra) {
  const card = el('div', { class: 'card', style: 'margin-bottom:12px' });
  card.append(el('div', { class: 'card-head' },
    el('h3', {}, title),
    el('div', { class: 'spacer' }),
    el('span', { class: 'chip' + (rows.length ? '' : ' on') },
      rows.length ? rows.length.toLocaleString('en-IN') + ' to look at' : '✓ clean')));
  if (blurb) card.append(el('p', { class: 'small muted', style: 'margin:0 0 8px' }, blurb));
  if (extra) card.append(el('div', { class: 'row', style: 'margin-bottom:8px' }, extra));

  if (!rows.length) { host2.append(card); return; }

  for (const { t, why } of rows.slice(0, SHOW)) {
    const amt = +t.expense || +t.income || 0;
    card.append(el('div', { class: 'check-row', onclick: () => openTxEditor(t) },
      el('div', { style: 'min-width:0;flex:1' },
        el('div', { class: 't1' }, `${fmtDate(t.date)} · ${t.account}`),
        el('div', { class: 't2' }, [t.note, t.parent, t.payee].filter(Boolean).join(' · ') || t.type),
        el('div', { class: 't3' }, why)),
      el('div', { class: 'check-amt' }, money(amt, t.currency), el('span', { class: 'go' }, '›'))));
  }
  if (rows.length > SHOW) card.append(el('p', { class: 'small muted', style: 'margin:8px 0 0' },
    `Showing the first ${SHOW}. Fix these and the rest will come up.`));
  host2.append(card);
}

/**
 * An account that ended up holding two currencies. That happens when a name was
 * used as a bucket for several old accounts — the balance then adds riyals to
 * rupees, which is a number that means nothing.
 */
function mixedAccounts() {
  const out = [];
  for (const a of DB.accounts) {
    if (a.deleted) continue;
    const rows = DB.transactions.filter(t => !t.deleted && t.account === a.name);
    const others = [...new Set(rows.map(t => t.currency).filter(c => c && c !== a.currency))];
    if (!others.length) continue;
    out.push({
      account: a, others,
      groups: others.map(c => {
        const list = rows.filter(t => t.currency === c);
        return { currency: c, rows: list,
          net: round2(list.reduce((s, t) => s + (+t.income || 0) - (+t.expense || 0), 0)) };
      }),
      ownRows: rows.filter(t => t.currency === a.currency).length,
    });
  }
  return out;
}

/**
 * Move the odd-currency rows onto an account of their own. Nothing is converted
 * and no amount is touched — the entries simply stop pretending to belong to an
 * account in a different currency. What DOES change is the total: a riyal that
 * was being counted as a rupee now counts as a riyal.
 */
async function splitOffCurrency(acct, group) {
  const name = `${acct.name} (${group.currency})`;
  if (DB.accounts.some(a => !a.deleted && a.name === name))
    return toast(`There is already an account called “${name}”`, 'warn', 5000);

  const before = C.netWorth().total;
  // Only 'primary' and 'investment' accounts feed the totals — an account filed
  // under Other is already outside them, so splitting it moves no money at all.
  const counted = ['primary', 'investment'].includes(acct.grp) && acct.active !== false;
  const shift = counted
    ? round2(C.liveINR(group.net, group.currency) - C.liveINR(group.net, acct.currency))
    : 0;

  const ok = await confirmBox(
    `Move ${group.rows.length} ${group.currency} entries off “${acct.name}” onto a new account called `
    + `“${name}”?\n\nNo amount is changed and nothing is converted — the entries keep exactly the figures `
    + `they have.\n\n`
    + (!counted
      ? `Your totals do not move: “${acct.name}” is filed under “${acct.grp || 'other'}”, which net worth `
        + `does not count. This only splits one meaningless balance into two honest ones.`
      : `Because ${group.currency} was being added up as ${acct.currency}, your net worth will `
        + `${shift < 0 ? 'drop' : 'rise'} by about ${money(Math.abs(shift), 'INR')}. That difference was `
        + `always wrong; this is it being put right.`),
    'Split them off');
  if (!ok) return;

  await put('accounts', {
    name, currency: group.currency, grp: acct.grp || 'other',
    opening_bal: 0, created_at: todayISO(), pinned: false,
    icon: acct.icon || null,
  });
  await putMany('transactions', group.rows.map(t => ({ ...t, account: name })));

  const after = C.netWorth().total;
  const moved = round2(after - before);
  toast(`${group.rows.length} entries moved to “${name}”`
    + (moved ? ` — net worth ${moved > 0 ? '+' : ''}${money(moved, 'INR')}` : ' — totals unchanged'),
    'ok', 8000);
  draw();
}

function mixedCard() {
  const mixed = mixedAccounts();
  if (!mixed.length) return;
  const card = el('div', { class: 'card', style: 'margin-bottom:12px' });
  card.append(el('div', { class: 'card-head' }, el('h3', {}, 'One account, two currencies'),
    el('div', { class: 'spacer' }),
    el('span', { class: 'chip' }, mixed.length + (mixed.length === 1 ? ' account' : ' accounts'))));
  card.append(el('p', { class: 'small muted', style: 'margin:0 0 8px' },
    'A balance can only be in one currency. Where a name was used as a bucket for several old accounts, '
    + 'the other currency is being added up as though it were this one. Splitting it off leaves every '
    + 'entry exactly as it is — it only stops the two being added together.'));

  for (const m of mixed) {
    for (const g of m.groups) {
      card.append(el('div', { class: 'check-row', style: 'cursor:default' },
        el('div', { style: 'min-width:0;flex:1' },
          el('div', { class: 't1' }, `${m.account.name} · ${m.account.currency}`),
          el('div', { class: 't2' },
            `${m.ownRows} in ${m.account.currency} · ${g.rows.length} in ${g.currency}`),
          el('div', { class: 't3' },
            `${g.currency} ${num(g.net)} is being counted as ${m.account.currency}`
            + (['primary', 'investment'].includes(m.account.grp) && m.account.active !== false
              ? '' : ' · this account is outside your totals, so nothing moves'))),
        el('button', { class: 'btn sm', onclick: () => splitOffCurrency(m.account, g) },
          `Split off ${g.currency}`)));
    }
  }
  host.append(card);
}

function check() {
  const cur = currencyOdd(), lb = lbOdd(), nc = noCategory();
  const total = cur.length + lb.length + nc.length;

  host.append(el('div', { class: 'alert ' + (total ? 'soon' : 'ok'), style: 'margin-bottom:12px' },
    el('span', { class: 'ico' }, total ? '⚠' : '✓'),
    el('div', {}, el('b', {}, total
      ? `${total.toLocaleString('en-IN')} entries worth a second look`
      : 'Nothing looks out of place'),
      el('div', { class: 'small muted' },
        'Nothing here is wrong on its own — the app will not change any of it. '
        + 'Tap a line to open that entry and decide for yourself.'))));

  mixedCard();

  checkGroup(host, 'Currency does not match the account',
    'The account is in one currency and the entry says another. Balances use the account’s currency, '
    + 'reports use the entry’s — so the same money can read two different ways.',
    cur);

  checkGroup(host, 'Lend / Borrow under old labels',
    'These came from the workbook filed under labels like a bare “Repayment”. '
    + 'Lend / Borrow should only ever be Lend (Lend · Collecting debts) or Borrow (Borrow · Repayment). '
    + 'No amount changes either way — only the label.',
    lb,
    lb.length ? el('button', { class: 'btn sm primary', onclick: tidyLendBorrow }, '✓ Fix all ' + lb.length) : null);

  checkGroup(host, 'No category', 'These land nowhere in any breakdown.', nc);
}

/** How many entries the Data check tab would show — used for the tab badge. */
function checkCount() {
  try { return currencyOdd().length + lbOdd().length + noCategory().length; } catch { return 0; }
}

function exportAllCSV() {
  const head = ['No', 'Date', 'Time', 'Type', 'Account', 'Currency', 'Income', 'Expense', 'Parent Category',
    'Sub Category', 'Payee', 'Event', 'Description', 'FX Rate', 'Income INR', 'Expense INR'];
  downloadCSV(`jinnyfin-all-transactions-${todayISO()}.csv`,
    [head, ...DB.transactions.map(t => [t.no ?? '', t.date, t.time || '', t.type, t.account, t.currency,
      t.income || 0, t.expense || 0, t.parent || '', t.sub || '', t.payee || '', t.event || '', t.note || '',
      t.fx || '', C.inrOf(t).toFixed(2), C.inrOut(t).toFixed(2)])]);
}

async function importSeed() {
  if (DB.transactions.length && !(await confirmBox(
    `There are already ${DB.transactions.length.toLocaleString('en-IN')} transactions here. Import the workbook data on top? Duplicates are likely.`))) return;
  const { runImport } = await import('./importer.js');
  runImport();
}

async function wipeAll() {
  if (!(await confirmBox('This deletes every transaction, account and setting on the server and on all your devices. Are you sure?', 'Delete everything'))) return;
  if (!(await confirmBox('Last chance — download a backup first if you have not. Continue?', 'Yes, delete'))) return;
  for (const t of TABLES) {
    const rows = DB[t].map(r => ({ ...r, deleted: true }));
    if (rows.length) await putMany(t, rows);
  }
  await sync();
  await resetLocal();
  toast('Everything cleared');
  location.reload();
}
