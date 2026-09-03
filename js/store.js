// ============================================================================
//  store.js — local database (IndexedDB) + two-way sync with Supabase
//
//  Everything the UI reads comes from memory (DB.tx, DB.accounts …), so screens
//  are instant even with 25,000 transactions and work with no internet at all.
//  Writes go: memory → IndexedDB → (when online) Supabase.
// ============================================================================
import { CONFIG } from '../config.js';
import { uuid, todayISO, toast, store as safeStore, storageBlocked } from './util.js';

export const TABLES = ['accounts', 'categories', 'payees', 'transactions', 'fx_rates',
  'assets', 'insurance', 'cards', 'equity_positions', 'equity_trades', 'businesses',
  'budgets', 'templates', 'tasks', 'settings'];

export const DB = {
  accounts: [], categories: [], payees: [], transactions: [], fx_rates: [],
  assets: [], insurance: [], cards: [], equity_positions: [], equity_trades: [],
  businesses: [], budgets: [], templates: [], tasks: [], settings: [],
};

/**
 * Every column each table really has — taken from supabase/schema.sql plus the
 * migrations. Screens work with enriched copies of a row: an insurance policy
 * picks up `daysLeft` and `level` on its way to the page, a fixed asset picks up
 * `gain` and `gainPct`. An editor that then saved `{ ...row, … }` handed those
 * invented fields to the database, which rightly refused them — and the app
 * warned about a missing migration that was never missing.
 *
 * Nothing is lost by dropping them: every one is worked out again from the real
 * columns each time a screen draws. A table missing from this map is left
 * untouched, so a new table can never be quietly emptied by a list nobody
 * remembered to update.
 */
export const COLUMNS = {
  accounts: ['id', 'user_id', 'name', 'currency', 'grp', 'opening_bal', 'active', 'pinned',
    'created_at', 'stated_balance', 'reconciled_at', 'sort', 'icon', 'deleted', 'updated_at'],
  categories: ['id', 'user_id', 'type', 'parent', 'sub', 'icon', 'color', 'deleted', 'updated_at'],
  payees: ['id', 'user_id', 'name', 'note', 'deleted', 'updated_at'],
  transactions: ['id', 'user_id', 'no', 'date', 'time', 'type', 'account', 'currency', 'income',
    'expense', 'parent', 'sub', 'payee', 'event', 'note', 'fx', 'transfer_group', 'to_account',
    'deleted', 'updated_at'],
  fx_rates: ['id', 'user_id', 'month', 'rate', 'source', 'deleted', 'updated_at'],
  assets: ['id', 'user_id', 'name', 'category_tag', 'opening_cost', 'market_value', 'market_date',
    'note', 'deleted', 'updated_at'],
  insurance: ['id', 'user_id', 'label', 'policy', 'policy_no', 'renewal_date', 'premium', 'currency',
    'notify_days', 'kind', 'pay_account', 'last_paid', 'note', 'deleted', 'updated_at'],
  cards: ['id', 'user_id', 'label', 'bank', 'network', 'kind', 'last4', 'expiry_hint',
    'enc_blob', 'enc_iv', 'enc_salt', 'deleted', 'updated_at'],
  equity_positions: ['id', 'user_id', 'symbol', 'company', 'qty', 'avg_cost', 'price', 'price_date',
    'closed', 'buy_qty', 'buy_value', 'sell_qty', 'sell_value', 'realised', 'dividends',
    'deleted', 'updated_at'],
  equity_trades: ['id', 'user_id', 'date', 'symbol', 'company', 'exchange', 'action', 'qty', 'rate',
    'value', 'source', 'deleted', 'updated_at'],
  businesses: ['id', 'user_id', 'name', 'income_parent', 'income_sub', 'expense_parent',
    'expense_sub', 'deleted', 'updated_at'],
  budgets: ['id', 'user_id', 'parent', 'sub', 'amount', 'currency', 'period', 'deleted', 'updated_at'],
  templates: ['id', 'user_id', 'label', 'payload', 'sort', 'deleted', 'updated_at'],
  tasks: ['id', 'user_id', 'title', 'note', 'due_date', 'due_time', 'repeat', 'priority', 'done',
    'done_at', 'deleted', 'updated_at'],
  settings: ['id', 'user_id', 'data', 'deleted', 'updated_at'],
};

/** A copy of the row carrying only the fields the table actually holds. */
export function onlyColumns(table, row) {
  const cols = COLUMNS[table];
  if (!cols || !row || typeof row !== 'object') return row;
  const out = {};
  for (const k of cols) if (k in row) out[k] = row[k];
  return out;
}

export const state = {
  user: null, online: navigator.onLine, syncing: false,
  lastSync: null, pending: 0, ready: false, sb: null, sbError: null, sbLoading: null,
  storageError: null,
};

const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = (what = 'data') => listeners.forEach(f => { try { f(what); } catch (e) { console.error(e); } });

// ------------------------------------------------------------ IndexedDB ---
let idb = null;
function openIDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('jinnyfin', 2);   // 2: added 'tasks'
    rq.onupgradeneeded = () => {
      const d = rq.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('_meta')) d.createObjectStore('_meta', { keyPath: 'k' });
      if (!d.objectStoreNames.contains('_queue')) d.createObjectStore('_queue', { keyPath: 'qid', autoIncrement: true });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
// Everything below tolerates idb being null: some browsers refuse storage
// outright ("The user denied permission to access the database"). In that mode
// the ledger lives in memory for the session and still syncs to the server —
// what you lose is offline use, not the app.
const mem = { meta: {}, queue: [], qid: 1 };
const txn = (stores, mode = 'readonly') => idb.transaction(stores, mode);
const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

async function idbAll(store) {
  if (!idb) return [];
  return new Promise((res, rej) => {
    const rq = txn([store]).objectStore(store).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
  });
}
async function idbPut(store, rows) {
  if (!idb) return;
  const t = txn([store], 'readwrite'), os = t.objectStore(store);
  for (const r of rows) os.put(r);
  return done(t);
}
async function meta(k, v) {
  if (!idb) {
    if (v === undefined) return mem.meta[k] ?? safeStore('jinnyfin-' + k) ?? undefined;
    mem.meta[k] = v; safeStore('jinnyfin-' + k, v); return;
  }
  if (v === undefined) {
    return new Promise(res => {
      const rq = txn(['_meta']).objectStore('_meta').get(k);
      rq.onsuccess = () => res(rq.result?.v); rq.onerror = () => res(undefined);
    });
  }
  const t = txn(['_meta'], 'readwrite'); t.objectStore('_meta').put({ k, v }); return done(t);
}

// --------------------------------------------------------------- Supabase --
// The client library is fetched once from a CDN and then served from the
// service-worker cache. A failed fetch we can catch — but a fetch that simply
// HANGS (slow mobile data, a network that silently swallows one of these hosts)
// would leave the whole app waiting forever on the loading spinner. So: give it
// a deadline, and keep spare hosts in case one is unreachable.
const CDNS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://esm.sh/@supabase/supabase-js@2',
  'https://unpkg.com/@supabase/supabase-js@2/dist/module/index.js',
];
const deadline = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out after ' + ms / 1000 + 's')), ms)),
]);

async function loadClient(ms) {
  let last;
  for (const url of CDNS) {
    try { return await deadline(import(/* @vite-ignore */ url), ms, new URL(url).host); }
    catch (e) { last = e; console.warn('[supabase] ' + (e.message || e)); }
  }
  throw last || new Error('No CDN reachable');
}

export async function initSupabase({ quiet = true, ms = 9000 } = {}) {
  if (state.sb) return state.sb;
  if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.startsWith('PASTE')) return null;
  if (state.sbLoading) return state.sbLoading;
  try {
    state.sbLoading = (async () => {
    const { createClient } = await loadClient(ms);
    state.sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true, autoRefreshToken: true, storageKey: 'jinnyfin-auth',
        storage: {
          getItem: k => safeStore(k),
          setItem: (k, v) => { safeStore(k, v); },
          removeItem: k => { safeStore(k, null); },
        },
      },
    });
    const { data } = await state.sb.auth.getSession();
    state.user = data?.session?.user || null;
    state.sb.auth.onAuthStateChange((_e, s) => { state.user = s?.user || null; emit('auth'); });
    state.sbError = null;
    return state.sb;
    })();
    return await state.sbLoading;
  } catch (e) {
    state.sbLoading = null;
    state.sbError = e.message || String(e);
    console.warn('[supabase] could not load the client:', state.sbError);
    if (!quiet) throw new Error('Could not reach the server (' + state.sbError + '). The app still works offline — try signing in again when the connection is better.');
    return null;
  }
}

export async function signIn(email, password) {
  const sb = await initSupabase({ quiet: false, ms: 15000 });
  if (!sb) throw new Error('Supabase is not configured — edit config.js first.');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  state.user = data.user; emit('auth'); return data.user;
}
export async function signUp(email, password) {
  const sb = await initSupabase();
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}
export async function signOut() {
  if (state.sb) await state.sb.auth.signOut();
  state.user = null; emit('auth');
}

/**
 * Change the account password. Supabase will change it from an open session
 * alone, so the current password is re-checked first — otherwise a borrowed
 * unlocked phone is enough to lock the owner out of their own data.
 */
export async function changePassword(current, next) {
  const sb = await initSupabase({ quiet: false, ms: 15000 });
  if (!sb) throw new Error('Not connected \u2014 sign in first.');
  const email = state.user?.email;
  if (!email) throw new Error('Not signed in.');
  const { error: bad } = await sb.auth.signInWithPassword({ email, password: current });
  if (bad) throw new Error('That is not your current password.');
  const { error } = await sb.auth.updateUser({ password: next });
  if (error) throw error;
  return true;
}

/** Emails a reset link \u2014 the way back in when the current password is lost. */
export async function sendPasswordReset(email) {
  const sb = await initSupabase({ quiet: false, ms: 15000 });
  if (!sb) throw new Error('Not connected.');
  const { error } = await sb.auth.resetPasswordForEmail(email,
    { redirectTo: location.origin + location.pathname });
  if (error) throw error;
  return true;
}

// ------------------------------------------------------------------ boot ---
export async function boot() {
  // Some mobile browsers (private mode, tight storage) never settle the open
  // request. Cap the wait so a hung database cannot hold the whole app hostage.
  try {
    idb = await Promise.race([
      openIDB(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB timed out')), 8000)),
    ]);
  } catch (e) {
    idb = null;
    state.storageError = e.message || String(e);
    console.warn('[store] no local database — running in memory:', state.storageError);
  }
  for (const t of TABLES) DB[t] = (await idbAll(t)).filter(r => !r.deleted);
  state.lastSync = await meta('lastSync');
  state.pending = (await queueAll()).length;
  state.ready = true;
  sortAll();
  emit('boot');
  // Six seconds is plenty on any usable connection. If the library turns up
  // later, onAuthStateChange re-renders — better a login screen now than a
  // spinner forever.
  try {
    await deadline(initSupabase({ ms: 6000 }), 6500, 'sign-in service');
  } catch (e) {
    console.warn('[boot] carrying on without the server:', e.message || e);
  }
  if (state.user && navigator.onLine) sync().catch(console.warn);
}

function sortAll() {
  // Date, then the clock time, then the row number. The time used to be ignored
  // altogether, so two entries on the same day sat in whatever order they were
  // typed — an evening payment could end up above a morning one, and the newest
  // entry of the day was not the one at the top of the list.
  // Times are stored as zero-padded HH:MM, so comparing them as text is right;
  // an entry with no time at all counts as the earliest of that day.
  DB.transactions.sort((a, b) =>
    (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || String(a.time || '').localeCompare(String(b.time || ''))
    || (a.no || 0) - (b.no || 0));
  DB.fx_rates.sort((a, b) => a.month < b.month ? -1 : 1);
  DB.accounts.sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

// --------------------------------------------------------------- queue -----
async function queuePush(table, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return;
  if (!idb) { for (const row of list) mem.queue.push({ qid: mem.qid++, table, row, at: Date.now() }); state.pending += list.length; return; }
  const t = txn(['_queue'], 'readwrite'), os = t.objectStore('_queue');
  const at = Date.now();
  for (const row of list) os.put({ table, row, at });
  await done(t); state.pending += list.length;
}
async function queueAll() {
  if (!idb) return mem.queue.slice();
  return new Promise(res => {
    const rq = txn(['_queue']).objectStore('_queue').getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  });
}
async function queueClear(qids) {
  if (!idb) { const drop = new Set(qids); mem.queue = mem.queue.filter(q => !drop.has(q.qid));
              state.pending = mem.queue.length; return; }
  const t = txn(['_queue'], 'readwrite'), os = t.objectStore('_queue');
  for (const q of qids) os.delete(q);
  await done(t); state.pending = Math.max(0, state.pending - qids.length);
}

// ------------------------------------------------------------- write API ---
/** Insert or update one row. Returns the stored row. */
export async function put(table, row, { silent = false } = {}) {
  const now = new Date().toISOString();
  const r = onlyColumns(table, { ...row, id: row.id || uuid(), updated_at: now, deleted: !!row.deleted });
  const arr = DB[table];
  const i = arr.findIndex(x => x.id === r.id);
  if (r.deleted) { if (i >= 0) arr.splice(i, 1); }
  else if (i >= 0) arr[i] = r; else arr.push(r);
  await idbPut(table, [r]);
  await queuePush(table, r);
  if (table === 'transactions') sortAll();
  if (!silent) { emit('data'); syncSoon(); }
  return r;
}
/** Bulk insert (import). Much faster than put() in a loop. */
export async function putMany(table, rows, { queue = true } = {}) {
  const now = new Date().toISOString();
  const out = rows.map(r => onlyColumns(table,
    { ...r, id: r.id || uuid(), updated_at: r.updated_at || now, deleted: !!r.deleted }));
  const byId = new Map(DB[table].map(r => [r.id, r]));
  for (const r of out) byId.set(r.id, r);
  DB[table] = [...byId.values()].filter(r => !r.deleted);
  await idbPut(table, out);
  if (queue) await queuePush(table, out);
  sortAll(); emit('data');
  return out;
}
export async function remove(table, id) {
  const row = DB[table].find(r => r.id === id);
  if (!row) return;
  return put(table, { ...row, deleted: true });
}

// ---------------------------------------------------------------- sync -----
let syncTimer = null;
export function syncSoon(ms = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(e => console.warn('sync', e)), ms);
}

/**
 * The name of the column the server says it does not have, or null.
 * PostgREST says: Could not find the 'reconciled_at' column of 'accounts' …
 * Postgres itself says: column "reconciled_at" of relation "accounts" does not exist
 */
function unknownColumn(error) {
  const m = String(error?.message || '');
  return m.match(/Could not find the '([^']+)' column/)?.[1]
      || m.match(/column "([^"]+)" of relation .* does not exist/)?.[1]
      || null;
}

export async function sync({ full = false } = {}) {
  if (state.syncing) return;
  if (!navigator.onLine) return;
  const sb = await initSupabase();
  if (!sb || !state.user) return;
  state.syncing = true; emit('sync');
  let pushed = 0;
  const skippedCols = new Set();
  try {
    // 1 ── push everything queued
    const q = await queueAll();
    if (q.length) {
      const byTable = {};
      for (const item of q) { if (!byTable[item.table]) byTable[item.table] = []; byTable[item.table].push(item); }
      for (const [table, items] of Object.entries(byTable)) {
        // keep only the newest version of each row
        const latest = new Map();
        for (const it of items) latest.set(it.row.id, it.row);
        // Filter here as well as in put(): a row queued by an older build may
        // still be carrying a worked-out field, and it should drain quietly
        // instead of raising a migration warning that is not true.
        let rows = [...latest.values()].map(r => onlyColumns(table, { ...r, user_id: state.user.id }));
        for (let i = 0; i < rows.length; i += 500) {
          let chunk = rows.slice(i, i + 500);
          let { error } = await sb.from(table).upsert(chunk, { onConflict: 'id' });
          // A column this app writes may not exist on the server yet — the SQL
          // migration has not been run. Rather than let one unknown column
          // freeze every sync forever, drop it and push the rest, then say so.
          for (let tries = 0; error && tries < 6; tries++) {
            const miss = unknownColumn(error);
            if (!miss) break;
            skippedCols.add(`${table}.${miss}`);
            chunk = chunk.map(r => { const { [miss]: _drop, ...rest } = r; return rest; });
            rows = rows.map(r => { const { [miss]: _d, ...rest } = r; return rest; });
            ({ error } = await sb.from(table).upsert(chunk, { onConflict: 'id' }));
          }
          if (error) throw error;
        }
      }
      await queueClear(q.map(i => i.qid));
      pushed = q.length;
    }
    // 2 ── pull everything changed since the last sync
    const since = full ? '1970-01-01T00:00:00Z' : (state.lastSync || '1970-01-01T00:00:00Z');
    const stamp = new Date().toISOString();
    let pulled = 0;
    for (const table of TABLES) {
      let from = 0, page = 1000, got;
      do {
        const { data, error } = await sb.from(table).select('*')
          .gt('updated_at', since).order('updated_at', { ascending: true })
          .range(from, from + page - 1);
        if (error) throw error;
        got = data || [];
        if (got.length) { await mergeRemote(table, got); pulled += got.length; }
        from += page;
      } while (got.length === page);
    }
    state.lastSync = stamp; await meta('lastSync', stamp);
    // Only announce a change when something actually changed. Coming back to the
    // app fires a sync; if it brings nothing new, the screen must not be rebuilt
    // underneath you — that is what kept throwing the page back to the top.
    if (pulled || pushed) { sortAll(); emit('data'); }
    if (skippedCols.size) {
      state.schemaGap = [...skippedCols];
      toast(`Synced, but your database is missing ${skippedCols.size} column(s): `
        + [...skippedCols].join(', ') + '. Run migration-1.17.sql in Supabase.', 'warn', 9000);
    } else state.schemaGap = null;
  } catch (e) {
    console.warn('[sync]', e.message || e);
    if (!/Failed to fetch|NetworkError/i.test(e.message || '')) toast('Sync problem: ' + (e.message || e), 'warn', 4000);
  } finally { state.syncing = false; emit('sync'); }
}

async function mergeRemote(table, rows) {
  const byId = new Map(DB[table].map(r => [r.id, r]));
  const keep = [];
  for (const r of rows) {
    const local = byId.get(r.id);
    // last-write-wins; a local row that is still queued always wins
    if (local && local.updated_at > r.updated_at) continue;
    keep.push(r);
    if (r.deleted) byId.delete(r.id); else byId.set(r.id, r);
  }
  if (keep.length) await idbPut(table, keep);
  DB[table] = [...byId.values()];
}

/** Wipe the local copy and pull everything again. */
export async function resetLocal() {
  if (!idb) {
    mem.meta = {}; mem.queue = []; for (const k of TABLES) DB[k] = [];
    state.lastSync = null; state.pending = 0; emit('data'); return;
  }
  const t = txn([...TABLES, '_meta', '_queue'], 'readwrite');
  for (const s of [...TABLES, '_meta', '_queue']) t.objectStore(s).clear();
  await done(t);
  for (const k of TABLES) DB[k] = [];
  state.lastSync = null; state.pending = 0;
  emit('data');
}

// -------------------------------------------------------------- settings ---
export function getSettings() {
  return DB.settings[0]?.data || {};
}
export async function setSettings(patch) {
  const cur = DB.settings[0];
  const data = { ...(cur?.data || {}), ...patch };
  // The settings table allows one row per user. Deriving its id from the user id
  // means two devices that both write settings before their first sync land on
  // the same row instead of colliding on that unique constraint.
  const id = cur?.id || state.user?.id || undefined;
  return put('settings', { ...(cur || {}), ...(id ? { id } : {}), data });
}

window.addEventListener('online', () => { state.online = true; emit('sync'); syncSoon(300); });
window.addEventListener('offline', () => { state.online = false; emit('sync'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(500); });
