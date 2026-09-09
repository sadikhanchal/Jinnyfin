// ============================================================================
//  settings.js — accounts, categories, FX rates, reconciliation, backup, import.
// ============================================================================
import { el, money, num, fmtDate, todayISO, modal, toast, confirmBox, downloadCSV, downloadFile, monthStart, MONTHS,
  dateGuard, restoreDateFocus, uuid } from '../util.js';
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
let showArchivedCats = false;  // and archived categories do too
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
  restoreDateFocus(host);        // put the cursor back in the date box the redraw ate
}

// ------------------------------------------------------------------ general
function general() {
  const s = getSettings();
  // ------------------------------------------------------------ app lock --
  const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'New PIN (4+ digits)' });
  host.append(el('div', { class: 'card' },
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
    // The stylesheet carries its own stamp, because a stale CSS file is
    // invisible otherwise: the app looks almost right and you cannot tell.
    (() => {
      const css = (getComputedStyle(document.documentElement)
        .getPropertyValue('--jf-css') || '').replace(/["'\s]/g, '');
      const ok = css === BUILD.version;
      return el('p', { class: 'small', style: 'margin:0 0 8px' },
        el('b', {}, 'Stylesheet: '),
        el('span', { class: ok ? 'pos' : 'neg' }, css || 'not stamped'),
        el('span', { class: 'muted' }, ok ? '  \u2014 matches the app.'
          : css ? '  \u2014 OLDER THAN THE APP. css/app.css did not land; upload it again.'
            : '  \u2014 this stylesheet is older than 1.24, so it has no stamp yet.'));
    })(),
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
  // Your arrangement, the same one Reconcile and every dropdown now shows.
  const all = [...DB.accounts];
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
          // A new account joins at the end of your arrangement. Without this it
          // keeps the default 0 and jumps to the top of every list.
          sort: v.sort ?? (Math.max(-1, ...DB.accounts.map(x => x.sort || 0)) + 1),
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
    if (c.active === false && !showArchivedCats) continue;
    if (!byType[c.type]) byType[c.type] = {};
    byType[c.type][c.parent] = [...(byType[c.type][c.parent] || []), c];
  }
  const archived = DB.categories.filter(c => c.active === false).length;
  host.append(el('div', { class: 'row', style: 'margin-bottom:10px' },
    el('button', { class: 'btn sm primary', onclick: () => editCat() }, '+ Category'),
    archived ? el('label', { class: 'chip', style: 'cursor:pointer' },
      el('input', { type: 'checkbox', checked: showArchivedCats,
        onchange: e => { showArchivedCats = e.target.checked; draw(); } }),
      ` show ${archived} archived`) : null));
  host.append(el('p', { class: 'small muted', style: 'margin:0 0 10px' },
    'Archiving takes a category out of every picker and leaves it on every entry that already uses it. '
    + 'Use it for something like Family Visit that you may need again years later.'));
  for (const [type, parents] of Object.entries(byType)) {
    const card = el('div', { class: 'card', style: 'margin-bottom:12px' },
      el('div', { class: 'card-head' }, el('h3', {}, `${type} — ${Object.keys(parents).length} categories`)));
    for (const [parent, list] of Object.entries(parents).sort()) {
      const subs = list.filter(c => c.sub);
      const live = list.some(c => c.active !== false);
      // By type as well as name: "Gift" can be an Income category and an Expense
      // one, and counting them together overstated both.
      const used = DB.transactions.filter(t => !t.deleted && t.type === type && t.parent === parent).length;
      card.append(el('div', { style: 'padding:7px 0;border-bottom:1px solid var(--grid)' },
        el('div', { class: 'row' },
          el('b', { style: live ? '' : 'opacity:.55' }, parent),
          live ? null : el('span', { class: 'small muted' }, ' · archived'),
          el('div', { class: 'spacer' }),
          el('span', { class: 'small muted' }, used + ' entries'),
          el('button', { class: 'icon-btn',
            title: live
              ? `Archive — the ${used} entries keep it, the pickers lose it`
              : 'Bring it back into the pickers',
            onclick: async () => {
              // Every row under the name flips together, so the parent leaves
              // the dropdown as one thing rather than half of one.
              await putMany('categories', list.map(c => ({ ...c, active: !live })));
              toast(live ? `${parent} archived` : `${parent} is back`);
              draw();
            } }, live ? '🗄' : '↩'),
          el('button', { class: 'icon-btn', title: 'Add a sub-category',
            onclick: () => editCat({ type, parent, sub: null }) }, '+')),
        subs.length ? el('div', { class: 'pill-list', style: 'margin-top:5px' },
          subs.map(c => el('button', {
            class: 'chip', style: c.active === false ? 'opacity:.55' : '',
            onclick: () => editCat(c),
          }, c.sub + (c.active === false ? ' · archived' : '')))) : null));
    }
    host.append(card);
  }
}

/**
 * How many entries this category row is actually on. A row naming a sub counts
 * that sub alone; a row that is only a category counts everything filed under
 * the name, sub or no sub, because the name is what would be going away.
 */
function usageOf(c) {
  if (!c || !c.parent) return 0;
  return DB.transactions.filter(t => !t.deleted && t.type === c.type && t.parent === c.parent
    && (c.sub ? t.sub === c.sub : true)).length;
}

function editCat(c = null) {
  const v = c || { type: 'Expense', parent: '', sub: '' };
  const type = el('select', {}, ...['Expense', 'Income', 'Lend/Borrow', 'Investment'].map(t => el('option', { value: t, selected: v.type === t }, t)));
  const parent = el('input', { value: v.parent || '', list: 'dl-cp' });
  const sub = el('input', { value: v.sub || '' });
  const dl = el('datalist', { id: 'dl-cp' }); C.parentsFor(null).forEach(p => dl.append(el('option', { value: p })));
  const live = el('input', { type: 'checkbox', checked: v.active !== false });
  const fld = (l, n) => el('div', { class: 'field full' }, el('label', {}, l), n);
  const m = modal(c?.id ? 'Edit category' : 'New category',
    el('div', { class: 'form-grid' }, fld('Type', type), fld('Category', parent), fld('Sub-category', sub),
      el('label', { class: 'field full row', style: 'flex-direction:row;gap:8px;align-items:center' },
        live, ' Show in the pickers — untick to archive it without losing the old entries'),
      dl), {
    footer: [
      c?.id ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => {
          // Deleting a name that entries still carry does not tidy anything up:
          // the entries keep the text and the category behind it is gone, so
          // they answer to nothing in any picker or report. Archiving is what
          // he actually wants in that case, and it is offered here.
          const used = usageOf(c);
          if (used) {
            const what = c.sub ? `${c.parent} · ${c.sub}` : c.parent;
            const many = used === 1 ? '1 entry' : `${used} entries`;
            if (await confirmBox(
              `“${what}” is on ${many}. Deleting it leaves them pointing at a category that no longer exists. `
              + `Archive it instead — it goes out of the pickers and those ${used === 1 ? 'entries keeps' : 'entries keep'} their name. `
              + `To delete it for good, change ${used === 1 ? 'that entry' : 'those entries'} to another category first.`,
              'Archive it')) {
              await put('categories', { ...c, active: false });
              toast(`${what} archived`);
              m.close();
            }
            return;
          }
          if (await confirmBox('Remove this category?')) { await remove('categories', c.id); m.close(); }
        } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!parent.value.trim()) return toast('Category name?', 'warn');
        await put('categories', { ...v, type: type.value, parent: parent.value.trim(),
          sub: sub.value.trim() || null, active: live.checked });
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
  // Today's rates and the month-by-month history are the same subject read two
  // ways, so they sit side by side rather than on two different tabs.
  const st = getSettings();
  const sar = el('input', { type: 'number', step: '0.0001', value: C.rates().sar });
  const usd = el('input', { type: 'number', step: '0.0001', value: C.rates().usd });
  const today = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Today’s rates')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'These convert current balances. A past transaction keeps the rate of the month it '
      + 'happened in — that is what makes the historical totals match your sheet.'),
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, '1 SAR = ? INR'), sar),
      el('div', { class: 'field' }, el('label', {}, '1 USD = ? SAR'), usd),
      el('div', { class: 'field full' },
        el('button', { class: 'btn primary', onclick: async () => {
          await setSettings({ sar_to_inr: +sar.value, usd_to_sar: +usd.value });
          toast('Rates updated'); draw();
        } }, 'Save rates'))));
  const byMonth = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'SAR → INR by month')),
    el('p', { class: 'small muted', style: 'margin:0 0 8px' },
      'Each transaction is converted at the rate of its own month, exactly like the workbook. '
      + 'Add a rate whenever you transfer money and know the real rate you got.'),
    add);
  host.append(el('div', { class: 'grid g2' }, today, byMonth));
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
  const dateIn = el('input', { type: 'date', value: asOf || todayISO(), style: 'max-width:180px' });
  dateGuard(dateIn, v => {
    if ((v || null) === asOf) return;
    asOf = v || null; draw();
  }, 'asof');

  host.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Balances & reconciliation'), el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, 'As of'), dateIn),
    el('p', { class: 'small muted', style: 'margin:8px 0 0' },
      s.reconciled_at
        ? `Last reconciled ${fmtDate(s.reconciled_at)}. Balances above are computed up to the “as of” date.`
        : 'Type the balance your bank app shows into “Bank says”. Anything that does not match is a missing or wrong entry.')));

  // The four counters are recomputed in place after every box, so that typing a
  // column of balances never has to rebuild the page.
  const kpis = el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' });
  const paintKpis = () => {
    const set = rows.filter(r => r.stated != null);
    const diffs = set.filter(r => Math.abs(r.diff) > 0.01);
    const totalDiff = diffs.reduce((n, r) => n + (r.currency === 'SAR' ? r.diff * C.rates().sar : r.diff), 0);
    kpis.innerHTML = '';
    kpis.append(kpi('Accounts checked', `${set.length} / ${rows.length}`),
      kpi('Matching', String(set.length - diffs.length), 'income'),
      kpi('Off', String(diffs.length), diffs.length ? 'expense' : ''),
      kpi('Total difference ≈ INR', num(totalDiff), Math.abs(totalDiff) < 0.01 ? 'income' : 'expense'));
  };
  paintKpis();
  host.append(kpis);

  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, el('th', { style: 'width:34px' }, ''),
    el('th', {}, 'Account'), el('th', { class: 'n' }, 'App says'),
    el('th', { class: 'n' }, 'Bank says'), el('th', { class: 'n' }, 'Difference'), el('th', {}, 'Checked'))));
  const tb = el('tbody');
  makeSortable(tb, order => saveOrder(order));
  for (const r of rows) {
    const inp = el('input', {
      type: 'number', step: 'any', class: 'inline-num', value: r.stated ?? '',
      placeholder: '—', inputmode: 'decimal', dataset: { rk: r.id },
    });
    const gap = el('td', { class: 'n' });
    const seen = el('td', { class: 'small muted' });
    const paintRow = () => {
      const live = r.stated == null ? null : Math.round((r.computed - r.stated) * 100) / 100;
      gap.className = 'n ' + (live == null ? '' : Math.abs(live) <= 0.01 ? 'pos' : 'neg');
      gap.textContent = live == null ? '–' : (Math.abs(live) <= 0.01 ? '✓ match' : num(live));
      seen.textContent = r.checked ? fmtDate(r.checked) : '';
    };
    paintRow();
    // Saving on change (not on every keystroke) keeps the sync queue quiet.
    //
    // And it does NOT redraw. Rebuilding the tab here destroyed the box the Tab
    // key had already moved into — two digits in, cursor gone, and the next Tab
    // landing on Sign out. Only this row's difference and the four counters
    // above can have changed, so only those are repainted.
    inp.onchange = () => {
      const acct = DB.accounts.find(a => a.id === r.id);
      if (!acct) return;
      const v = inp.value.trim() === '' ? null : +inp.value;
      r.stated = v;
      r.checked = v == null ? null : (asOf || todayISO());
      r.diff = v == null ? null : round2(r.computed - v);
      paintRow(); paintKpis();
      Promise.resolve(put('accounts', { ...acct, stated_balance: v, reconciled_at: r.checked }))
        .catch(e => toast(e?.message || 'Could not save that balance', 'bad'));
    };
    tb.append(el('tr', { dataset: { id: r.id } },
      el('td', { class: 'drag-cell' }, el('span', { class: 'drag-grip', draggable: 'true', title: 'Drag to reorder' }, '\u283f')),
      el('td', {}, r.name),
      el('td', { class: 'n' }, money(r.computed, r.currency)),
      el('td', { class: 'n' }, inp), gap, seen));
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

  const half = pairHalfTransfers();
  const blank = DB.transactions.filter(t => !t.deleted && t.type === 'Transfer' && !t.parent).length;
  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Tidy up')),

    el('p', { class: 'small muted', style: 'margin:6px 0 4px' },
      'A transfer is two rows — one for the money leaving, one for it arriving. Everything the workbook '
      + 'brought in came as single rows with nothing tying the halves together, which is why opening one '
      + 'shows the other side as “— not known —”. Linking changes no amount, date or account: it only '
      + 'records that the two rows already in the ledger are one transfer.'),
    el('p', { class: 'small', style: 'margin:0 0 10px' },
      half.pairs.length
        ? `${half.pairs.length} pairs can be tied back together (${half.loose} unlinked in all).`
        : half.loose ? `${half.loose} unlinked, none of them pair up on their own.`
          : 'Every transfer has both its halves.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn' + (half.pairs.length ? ' primary' : ''),
        disabled: !half.pairs.length, onclick: linkHalfTransfers }, '⇄ Link half transfers')),

    el('p', { class: 'small muted', style: 'margin:14px 0 4px' },
      'Older transfers carried the category on the side the money left and nothing on the side it '
      + 'arrived, so the same transfer reads “Transfer” on one statement and leaves the Category column '
      + 'empty on the other. New ones no longer do this; these are the ones already saved.'),
    el('p', { class: 'small', style: 'margin:0 0 10px' },
      blank ? `${blank} entries have an empty Category column.` : 'Every transfer carries its category.'),
    el('div', { class: 'row' },
      el('button', { class: 'btn', disabled: !blank, onclick: fixTransferCategories },
        'Fill in blank transfer categories'))));

  host.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Numbers check')),
    verifyBlock()));
}

/** Give every transfer entry the category its other half already had. */
async function fixTransferCategories() {
  const legs = DB.transactions.filter(t => !t.deleted && t.type === 'Transfer' && !t.parent);
  if (!legs.length) { toast('Nothing to fix — every transfer already carries its category'); return; }
  const one = legs.length === 1;
  if (!(await confirmBox(
    `${legs.length} transfer ${one ? 'entry has' : 'entries have'} an empty Category column. `
    + `Fill ${one ? 'it' : 'them'} in with “Transfer”? Nothing else about ${one ? 'that entry' : 'those entries'} changes — `
    + 'no amount, no account, no date.', 'Fill them in'))) return;
  await putMany('transactions', legs.map(t => ({ ...t, parent: 'Transfer' })));
  toast(`${legs.length} ${one ? 'entry' : 'entries'} fixed`);
  draw();
}

// -------------------------------------------------- half-linked transfers ---
/**
 * A transfer is two rows sharing a group id. Everything the workbook import
 * brought in arrived as single rows with no group at all, which is why opening
 * one shows the other side as “— not known —”.
 *
 * This ties back together the halves that clearly belong to each other. Nothing
 * is invented: no row is created, and no amount, date or account is touched.
 * All that is written is a shared group id onto two rows already in the ledger.
 *
 * Five passes, most certain first, each row used at most once:
 *   1. same day, same currency, the same amount to the paisa
 *   2. same day, and the two notes name the same thing — "Preethi (To Federal
 *      bank NRO)" against "Preethi (From Big Ticket)". This has to come before
 *      the clock and the row number, because two remittances sent in the same
 *      minute are told apart by nothing else: 55 SAR and 220 SAR both leaving
 *      Big Ticket at 17:10, arriving as ₹1,200 and ₹4,800, get crossed by any
 *      rule that cannot read
 *   3. row numbers next to each other, a day apart at most — a pair typed one
 *      after the other in the sheet
 *   4. same day and the same minute on the clock
 *   5. same amount within three days, nearest day first
 *
 * Passes 3-5 still insist on the amount when both sides are in the SAME
 * currency. Without that guard two same-day rows get crossed — 143.59 out tied
 * to 42.00 in — and the ledger then tells a story that never happened.
 */
// Words that appear in half the notes in the book and so say nothing about
// WHICH transfer this is. A shared "from" or "bank" is not evidence.
const NOTE_NOISE = new Set(('from to the a an and of for in on at is was my our with by transfer'
  + ' transferred sent send send bank banks account accounts federal fed nro nri sib indian south'
  + ' cash home hand rajhi ahli jazira stc pay big ticket central gpay haseena money amount balance'
  + ' received paid pay rs inr sar usd one two three gm gms gram grams no nos total').split(/\s+/));

/**
 * The distinctive words a note is made of — names, places, what it was for.
 * Kept against the row itself: the matcher asks the same rows for their words
 * thousands of times over a 25,000-row ledger, and splitting the string afresh
 * every time is what turned a 20ms pass into half a second on a phone.
 */
const NOTE_CACHE = new WeakMap();
function noteWords(t) {
  let s = NOTE_CACHE.get(t);
  if (s) return s;
  s = new Set();
  for (const w of String(t.note || '').toLowerCase().split(/[^a-z0-9]+/))
    if (w.length >= 3 && !NOTE_NOISE.has(w) && !/^\d+$/.test(w)) s.add(w);
  NOTE_CACHE.set(t, s);
  return s;
}
function pairHalfTransfers() {
  const loose = DB.transactions.filter(t => !t.deleted && t.type === 'Transfer' && !t.transfer_group);
  const byNo = (a, b) => (+a.no || 0) - (+b.no || 0);
  const outs = loose.filter(t => +t.expense > 0).sort(byNo);
  const ins = loose.filter(t => +t.income > 0).sort(byNo);

  const inr = t => (+t.expense || +t.income || 0) * (+t.fx || 1);
  // A ledger this long holds only a couple of thousand distinct dates, and the
  // last pass compares nearly every row against every other one. Parsing the
  // same forty strings a million times is most of what that pass costs.
  const dayMemo = new Map();
  const day = d => {
    let v = dayMemo.get(d);
    if (v === undefined) { v = Date.parse(d + 'T00:00:00Z'); dayMemo.set(d, v); }
    return v;
  };
  const used = new Set();
  const byDate = new Map(), byNum = new Map();
  for (const t of ins) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
    if (t.no != null) byNum.set(+t.no, t);
  }
  // Same currency: the two sides must agree to the paisa. Different currencies:
  // they never will, and the rate he actually got is his own business.
  const amountOk = (o, i) => o.currency !== i.currency || Math.abs(inr(o) - inr(i)) < 0.02;
  const usable = (o, i) => !!i && !used.has(i.id) && i.account !== o.account;

  const pairs = [];
  const take = (o, i) => { used.add(o.id); used.add(i.id); pairs.push([o, i]); };

  for (const o of outs) {                                   // pass 1
    if (used.has(o.id)) continue;
    const hit = (byDate.get(o.date) || []).find(i => usable(o, i)
      && o.currency === i.currency && Math.abs(inr(o) - inr(i)) < 0.02);
    if (hit) take(o, hit);
  }
  // Pass 2: the notes name the same thing. Only a CLEAR winner counts — the
  // best-scoring candidate must beat every other one outright. Two notes that
  // tie tell us nothing, and a guess here silently swaps two people's money.
  for (const o of outs) {
    if (used.has(o.id)) continue;
    const mine = noteWords(o);
    if (!mine.size) continue;
    let best = null, bestScore = 0, tied = false;
    for (const i of byDate.get(o.date) || []) {
      if (!usable(o, i) || !amountOk(o, i)) continue;
      let n = 0;
      for (const w of noteWords(i)) if (mine.has(w)) n++;
      if (!n) continue;
      if (n > bestScore) { best = i; bestScore = n; tied = false; }
      else if (n === bestScore) tied = true;
    }
    if (best && !tied) take(o, best);
  }
  for (const o of outs) {                                   // pass 3
    if (used.has(o.id) || o.no == null) continue;
    for (const step of [1, -1, 2, -2]) {
      const i = byNum.get(+o.no + step);
      if (!usable(o, i) || !amountOk(o, i)) continue;
      if (Math.abs(day(o.date) - day(i.date)) > 864e5) continue;
      take(o, i); break;
    }
  }
  for (const o of outs) {                                   // pass 4
    if (used.has(o.id) || !o.time) continue;
    const hit = (byDate.get(o.date) || []).find(i => usable(o, i)
      && i.time === o.time && amountOk(o, i));
    if (hit) take(o, hit);
  }
  // Pass 5: cash walked into the bank on Monday and showed up on the statement
  // on Wednesday. Same currency and the same amount to the paisa, a few days
  // apart, nearest date wins. The amount is never waived here, so this cannot
  // cross two unrelated rows the way a looser rule would.
  // Only seven days can hold a candidate, so ask byDate for those seven rather
  // than walking the whole ledger for every row left over.
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  for (const o of outs) {
    if (used.has(o.id)) continue;
    const base = day(o.date);
    let best = null, bestGap = Infinity;
    for (const gap of [0, 1, -1, 2, -2, 3, -3]) {
      if (Math.abs(gap) >= bestGap) break;                 // nearer day already won
      for (const i of byDate.get(iso(base + gap * 864e5)) || []) {
        if (!usable(o, i) || i.currency !== o.currency) continue;
        if (Math.abs(inr(o) - inr(i)) >= 0.02) continue;
        best = i; bestGap = Math.abs(gap); break;
      }
    }
    if (best) take(o, best);
  }
  return { pairs, loose: loose.length };
}

async function linkHalfTransfers() {
  const { pairs, loose } = pairHalfTransfers();
  if (!pairs.length) {
    toast(loose
      ? `${loose} transfers are still missing their other half, but none of them pair up on their own`
      : 'Every transfer already has both its halves');
    return;
  }
  const rest = loose - pairs.length * 2;
  if (!(await confirmBox(
    `${pairs.length} half-linked transfers can be tied back to their other side `
    + `(${pairs.length * 2} entries). Every one keeps its own date, account and amount — `
    + 'the only change is that the app will know the two rows are one transfer.'
    + (rest ? ` ${rest} entries have no partner anywhere in the ledger and are left alone.` : ''),
    'Link them'))) return;
  const rows = [];
  for (const [o, i] of pairs) {
    const grp = uuid();
    rows.push({ ...o, transfer_group: grp, to_account: i.account, parent: o.parent || 'Transfer' });
    rows.push({ ...i, transfer_group: grp, to_account: null, parent: i.parent || 'Transfer' });
  }
  await putMany('transactions', rows);
  toast(`${pairs.length} transfers linked`);
  draw();
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

/**
 * A row whose account is not one of your accounts at all. Transfers saved
 * before 1.27.7 could write the literal words "— not known —" into the account
 * field when the other side had not been named, and that row then belongs to
 * nothing: it is in no account statement and no balance.
 */
const ghostAccount = () => {
  const real = new Set(DB.accounts.filter(a => !a.deleted).map(a => a.name));
  return DB.transactions
    .filter(t => !t.deleted && t.account && !real.has(t.account))
    .map(t => ({ t, why: `“${t.account}” is not one of your accounts — open it and pick the right one` }));
};

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
  const counted = ['primary', 'investment'].includes(acct.grp);
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
            + (['primary', 'investment'].includes(m.account.grp)
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

  checkGroup(host, 'Account does not exist',
    'The account named on these rows is not in your account list, so the money on them '
    + 'sits in no balance and shows on no statement. Open each one and pick the account it belongs to.',
    ghostAccount());
}

/** How many entries the Data check tab would show — used for the tab badge. */
function checkCount() {
  try { return currencyOdd().length + lbOdd().length + noCategory().length + ghostAccount().length; } catch { return 0; }
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
