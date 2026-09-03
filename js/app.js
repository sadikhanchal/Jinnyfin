// ============================================================================
//  app.js — shell, router, auth gate, screen lock.
// ============================================================================
import { CONFIG } from '../config.js';
import { $, el, toast, todayISO, store as safeStore, storageBlocked, confirmBox, modal, closeThen } from './util.js';
import * as S from './store.js';
import { DB, state, getSettings, setSettings } from './store.js';
import { insuranceHeadline } from './calc.js';
import { checkPin } from './crypto.js';
import { openTxEditor } from './views/editor.js';
import * as A from './alerts.js';
import * as Push from './push.js';

// Stamped at build time. Settings shows it, so “did the update land?” is a
// question you answer by looking, not by guessing.
export const BUILD = { version: '1.26', date: '2026-09-03' };

const ROUTES = {
  dashboard:    { title: 'Dashboard',        icon: '🏠', tab: 'Dashboard', load: () => import('./views/dashboard.js') },
  transactions: { title: 'Transactions',     icon: '📒', tab: 'Transactions', load: () => import('./views/transactions.js') },
  statement:    { title: 'Account Statement',icon: '🧾', tab: 'A/C Stmt', load: () => import('./views/statement.js') },
  expense:      { title: 'Expense Report',   icon: '💸', tab: 'Expense', load: () => import('./views/report.js').then(m => m.view('Expense')) },
  income:       { title: 'Income Report',    icon: '💵', load: () => import('./views/report.js').then(m => m.view('Income')) },
  incexp:       { title: 'Income vs Expense',icon: '⚖️', load: () => import('./views/incexp.js') },
  payee:        { title: 'Lend / Borrow',    icon: '🤝', load: () => import('./views/payee.js') },
  business:     { title: 'Business P&L',     icon: '📊', load: () => import('./views/business.js') },
  equity:       { title: 'Equity Portfolio', icon: '📈', load: () => import('./views/equity.js') },
  networth:     { title: 'Net Worth & Assets',icon: '🏦', load: () => import('./views/networth.js') },
  insurance:    { title: 'Insurance & Documents', icon: '🛡️', load: () => import('./views/insurance.js') },
  cards:        { title: 'Card Vault',       icon: '💳', load: () => import('./views/cards.js') },
  budgets:      { title: 'Budgets',          icon: '🎯', load: () => import('./views/budgets.js') },
  tasks:        { title: 'Reminders',        icon: '⏰', load: () => import('./views/tasks.js') },
  settings:     { title: 'Settings',         icon: '⚙️', load: () => import('./views/settings.js') },
};

const NAV = [
  { sep: 'Overview' }, 'dashboard', 'transactions', 'networth', 'budgets', 'tasks',
  { sep: 'Reports' }, 'expense', 'income', 'incexp', 'statement', 'payee', 'business', 'equity',
  { sep: 'Vault' }, 'insurance', 'cards',
  { sep: '' }, 'settings',
];

export const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard');
export const go = r => { location.hash = '#/' + r; };

// Where each screen was scrolled to. A background sync must not yank a long
// page back to the top just because the data underneath it changed.
const scrollMemo = Object.create(null);

// ---------------------------------------------------------------- drawer ---
// On a phone the sidebar is the same list, slid in from the left. One NAV
// array feeds both, so a new screen never has to be added in two places.
const TABS = ['dashboard', 'statement', null, 'expense'];   // null = the + button's slot
let drawerPushed = false;      // did opening the drawer add a history entry?
let pendingRoute = null;       // route to open once the drawer's entry is gone

const drawerOpen = () => document.body.classList.contains('drawer-open');

function openDrawer() {
  if (drawerOpen()) return;
  document.body.classList.add('drawer-open');
  markActive();
  // So the phone's back gesture closes the drawer instead of leaving the app.
  try { history.pushState({ jfDrawer: 1 }, ''); drawerPushed = true; } catch { drawerPushed = false; }
}

/** @param {boolean} rewind drop the history entry the drawer added. */
function closeDrawer(rewind = true) {
  if (!drawerOpen()) return;
  document.body.classList.remove('drawer-open');
  markActive();
  if (rewind && drawerPushed) history.back();   // popstate finishes the job
  else drawerPushed = false;
}

/**
 * Close the drawer and wait until its history entry is really gone. history.back()
 * lands on a later tick; anything that pushes its own entry in the meantime — a
 * confirm box, say — gets closed by that late popstate the moment it appears.
 */
function closeDrawerSettled() {
  const wasPushed = drawerOpen() && drawerPushed;
  closeDrawer();
  if (!wasPushed) return Promise.resolve();
  return new Promise(done => {
    const go_ = () => { removeEventListener('popstate', go_); clearTimeout(t); done(); };
    const t = setTimeout(go_, 400);            // never hang if the entry was already gone
    addEventListener('popstate', go_);
  });
}

/** Navigating from the drawer: unwind its history entry FIRST, then route. */
function pickFromDrawer(r) {
  if (drawerPushed) { pendingRoute = r; closeDrawer(true); return; }
  closeDrawer(false); go(r);
}

addEventListener('popstate', () => {
  drawerPushed = false;
  closeDrawer(false);
  if (pendingRoute) { const r = pendingRoute; pendingRoute = null; go(r); }
});
addEventListener('keydown', e => { if (e.key === 'Escape' && drawerOpen()) closeDrawer(); });

// A swipe from the very left edge opens it; a swipe left over it closes it.
(function edgeSwipe() {
  let x0 = null, y0 = null, live = false;
  addEventListener('touchstart', e => {
    if (window.innerWidth > 860) return;
    const t = e.touches[0];
    live = drawerOpen() || t.clientX < 24;
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (!live || x0 == null) return;
    const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dy) > Math.abs(dx)) { live = false; return; }   // that was a scroll
    if (!drawerOpen() && dx > 45) { openDrawer(); live = false; }
    if (drawerOpen() && dx < -45) { closeDrawer(); live = false; }
  }, { passive: true });
  addEventListener('touchend', () => { live = false; x0 = null; });
})();

/** The app mark — the same artwork as the home-screen icon. */
const brandMark = (size = 30) =>
  el('img', { class: 'brand-mark', src: 'icons/icon-192.png', alt: '',
              width: size, height: size, style: `width:${size}px;height:${size}px` });

// ---------------------------------------------------------------- render ---
let currentView = null;

async function renderShell() {
  const root = $('#root');
  root.innerHTML = '';
  const side = el('aside', { id: 'sidebar' },
    el('div', { class: 'brand' },
      brandMark(),
      el('div', { style: 'min-width:0' },
        el('div', { class: 'brand-name' }, 'Jinnyfin'), el('div', { class: 'brand-sub' }, 'Personal finance')),
      el('button', { class: 'icon-btn drawer-close', title: 'Close menu', onclick: () => closeDrawer() }, '✕')));
  for (const item of NAV) {
    if (typeof item === 'object') { side.append(el('div', { class: 'nav-sep' }, item.sep)); continue; }
    const r = ROUTES[item];
    side.append(el('button', {
      class: 'nav-link', dataset: { route: item }, onclick: () => pickFromDrawer(item),
    }, el('span', { class: 'nav-ico' }, r.icon), r.title));
  }
  side.append(el('div', { style: 'flex:1' }));
  side.append(el('button', { class: 'nav-link', onclick: toggleTheme }, el('span', { class: 'nav-ico' }, '◑'), 'Theme'));
  side.append(el('button', { class: 'nav-link', onclick: askSignOut }, el('span', { class: 'nav-ico' }, '⎋'), 'Sign out'));

  const main = el('main', { id: 'main' });
  // Tapping the dimmed page is the fastest way out of an open drawer.
  root.append(el('div', { class: 'drawer-back', onclick: () => closeDrawer() }), side, main);

  const tabs = el('nav', { id: 'tabbar' });
  for (const t of TABS) {
    if (t === null) {
      tabs.append(el('div', { class: 'fab-slot' },
        el('button', { class: 'fab', title: 'Add transaction', onclick: () => openTxEditor() }, '+')));
      continue;
    }
    tabs.append(el('button', { dataset: { route: t }, onclick: () => pickFromDrawer(t) },
      el('span', { class: 'i' }, ROUTES[t].icon), ROUTES[t].tab));
  }
  // Everything the four tabs cannot reach lives one tap away, behind ☰.
  tabs.append(el('button', {
    id: 'moretab', title: 'More screens',
    onclick: e => { e.stopPropagation(); drawerOpen() ? closeDrawer() : openDrawer(); },
  }, el('span', { class: 'i' }, '☰'), 'More'));
  root.append(tabs);
  root.append(el('button', { class: 'fab-desktop', title: 'Add transaction (N)', onclick: () => openTxEditor() }, '+'));
}

function markActive() {
  const r = route();
  document.querySelectorAll('[data-route]').forEach(n =>
    n.classList.toggle('active', n.dataset.route === r));
  // ☰ lights up when the screen you are on is not one of the four tabs — so a
  // glance at the bar always tells you where you are.
  const more = document.getElementById('moretab');
  if (more) more.classList.toggle('active', drawerOpen() || !TABS.includes(r));
}

export function topbar(title, ...right) {
  const chip = el('span', { class: 'sync-chip', id: 'syncchip', onclick: () => S.sync() });
  const bar = el('div', { class: 'topbar' }, el('h1', {}, title), el('div', { class: 'spacer' }),
    ...right, bellButton(), chip);
  updateChip(chip);
  watchLift(bar);
  return bar;
}

/** The hairline under the frozen bar appears only once it is actually holding
 *  content back — at the top of a page it would just be a line for no reason. */
function watchLift(bar) {
  const mark = () => bar.classList.toggle('lifted', bar.getBoundingClientRect().top <= 1 && window.scrollY > 4);
  mark();
  addEventListener('scroll', mark, { passive: true });
}

// ------------------------------------------------------------------ bell ---
// One button on every screen carrying one number: how many things are waiting
// that you have not looked at. Tapping it opens the same list the Reminders
// screen shows, so there is only ever one truth about what is unread.
function bellButton() {
  const b = el('button', { class: 'bell', id: 'bell', title: 'Reminders', onclick: openBell }, '🔔',
    el('span', { class: 'bell-count' }));
  paintBell(b);
  return b;
}
function paintBell(b) {
  b = b || $('#bell'); if (!b) return;
  let n = 0;
  try { n = A.unreadCount(); } catch { n = 0; }
  const dot = b.querySelector('.bell-count');
  if (!dot) return;
  dot.textContent = n > 99 ? '99+' : String(n);
  dot.style.display = n ? '' : 'none';
  b.classList.toggle('has', !!n);
}
export const refreshBell = () => paintBell();

async function openBell() {
  const { alertRow } = await import('./views/tasks.js');
  const body = el('div', { class: 'bell-list' });
  const fill = () => {
    body.innerHTML = '';
    const list = A.alerts();
    if (!list.length) {
      body.append(el('p', { class: 'small muted', style: 'margin:6px 2px' }, 'Nothing needs you right now.'));
    } else for (const a of list) body.append(alertRow(a,
      () => { fill(); paintBell(); },
      alert => closeThen(m, () => { location.hash = alert.go; })));
  };
  fill();
  const m = modal('Reminders', body, { footer: [
    el('button', { class: 'btn', onclick: async () => { await A.markAllRead(); fill(); paintBell(); } }, 'Mark all read'),
    el('button', { class: 'btn primary', onclick: () => closeThen(m, () => go('tasks')) }, 'Open reminders'),
  ] });
}

// ------------------------------------------------------- ringing on time ---
/** A short chime, made on the spot — no audio file to ship or fail to load. */
function chime() {
  if (getSettings().reminder_sound === false) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const now = ac.currentTime;
    [880, 1174.7].forEach((hz, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.35);
      o.connect(g); g.connect(ac.destination);
      o.start(now + i * 0.18); o.stop(now + i * 0.18 + 0.4);
    });
    setTimeout(() => ac.close(), 1200);
  } catch { /* a browser that will not make a sound is not a reason to fail */ }
}

/**
 * Every minute, and whenever you come back to the app: has anything fallen due
 * that has not been announced on this device yet? If so, ring once.
 */
async function ring() {
  let fresh = [];
  try { fresh = A.unrung(); } catch { return; }
  paintBell();
  if (!fresh.length) return;
  chime();
  const lead = fresh[0];
  const rest = fresh.length - 1;
  toast(`🔔 ${lead.title}${rest ? ` · and ${rest} more` : ''}`, 'warn', 8000,
    { label: 'Open', run: () => openBell() });
  if (getSettings().notify_on !== false && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const opts = { body: rest ? `and ${rest} more waiting` : (lead.body || ''), icon: 'icons/icon-192.png',
        tag: 'jinnyfin-reminder', badge: 'icons/icon-192.png' };
      if (reg) reg.showNotification('Jinnyfin · ' + lead.title, opts);
      else new Notification('Jinnyfin · ' + lead.title, opts);
    } catch { /* the browser said no; the in-app toast already did the job */ }
  }
}
let ringTimer = null;
export function startRinging() {
  if (ringTimer) return;
  ring();
  ringTimer = setInterval(ring, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ring(); });
}
function updateChip(chip) {
  chip = chip || $('#syncchip'); if (!chip) return;
  const s = state;
  let cls = 'dot', txt = 'Synced';
  if (!s.online) { cls += ' off'; txt = 'Offline'; }
  else if (s.syncing) { cls += ' busy'; txt = 'Syncing…'; }
  else if (s.pending) { cls += ' busy'; txt = s.pending + ' to sync'; }
  else if (!s.user) { cls += ' err'; txt = 'Not signed in'; }
  chip.innerHTML = '';
  chip.append(el('span', { class: cls }), txt);
}

async function renderRoute() {
  const r = route();
  const def = ROUTES[r] || ROUTES.dashboard;
  const main = $('#main');
  if (!main) return;
  if (drawerOpen()) closeDrawer(false);   // never leave it covering a new screen
  markActive();
  main.innerHTML = '<div class="row gap muted" style="padding:24px"><span class="spinner"></span> Loading…</div>';
  try {
    const mod = await def.load();
    currentView = mod;
    main.innerHTML = '';
    await mod.render(main);
    // Storage refused by the browser: one line, dismissible for the session.
    if (state.storageError && safeStore('jinnyfin-hide-storage-note', undefined, 'session') !== '1') {
      const note = el('div', { class: 'alert soon slim', style: 'margin-bottom:10px' },
        el('span', { class: 'ico' }, '⚠'),
        el('div', { class: 'small' }, 'Storage is blocked here — syncs fine, but no offline use.'),
        el('div', { style: 'flex:1' }),
        el('button', {
          class: 'icon-btn', title: 'Hide',
          onclick: () => { safeStore('jinnyfin-hide-storage-note', '1', 'session'); note.remove(); },
        }, '✕'));
      main.prepend(note);
    }
    // Land where this screen was left. A second pass after layout, because a
    // long list can still be measuring itself when the first one runs.
    const want = scrollMemo[r] || 0;
    window.scrollTo(0, want);
    if (want) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, want)));
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="empty"><div class="big">😕</div><p>Could not open <b>${def.title}</b>.</p><p class="small">${e.message}</p></div>`;
  }
}

// --------------------------------------------------------------- theme ----
function applyTheme() {
  const t = getSettings().theme || safeStore('jinnyfin-theme') || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
/** Signing out is one tap from the menu; on a device that cannot keep a session
 *  it means typing the password again. Worth a question first. */
export async function askSignOut() {
  await closeDrawerSettled();          // the question, not the menu, is the point
  const warn = storageBlocked() || state.storageError
    ? ' This device is not keeping your sign-in, so you will have to type your password again.'
    : ' You will need your password to get back in.';
  if (await confirmBox('Sign out of Jinnyfin?' + warn, 'Sign out')) S.signOut();
}

export function toggleTheme() {
  const cur = getSettings().theme || safeStore('jinnyfin-theme') || 'system';
  const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
  safeStore('jinnyfin-theme', next);
  setSettings({ theme: next });
  applyTheme();
  toast('Theme: ' + next);
}

// ---------------------------------------------------------------- login ---
function loginScreen(msg) {
  const root = $('#root');
  root.innerHTML = '';
  // When the browser refuses to keep anything, every reload lands here — so say
  // why, instead of letting it look like the app lost the password.
  const blocked = !!state.storageError || storageBlocked();
  const email = el('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'username', value: safeStore('jinnyfin-email') || '' });
  const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = el('p', { class: 'small', style: 'color:var(--critical);min-height:18px' }, msg || '');
  const btn = el('button', { class: 'btn primary', style: 'width:100%' }, 'Sign in');
  const doLogin = async () => {
    btn.disabled = true; err.textContent = '';
    try {
      safeStore('jinnyfin-email', email.value.trim());
      await S.signIn(email.value.trim(), pass.value);
      await S.sync({ full: !S.state.lastSync });
      start();
    } catch (e) { err.textContent = e.message || 'Sign-in failed'; btn.disabled = false; }
  };
  btn.onclick = doLogin;
  pass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  window.__jinnyfinReady = true;
  const configured = CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.startsWith('PASTE');
  root.append(el('div', { class: 'auth-wrap' },
    el('div', { class: 'card auth-card' },
      el('div', { class: 'brand', style: 'padding-left:0' },
        brandMark(44),
        el('div', {}, el('div', { class: 'brand-name' }, 'Jinnyfin'),
          el('div', { class: 'brand-sub' }, 'Sign in to sync this device'))),
      configured ? el('div', { class: 'grid', style: 'gap:10px' },
        el('div', { class: 'field' }, el('label', {}, 'Email'), email),
        el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
        err, btn,
        blocked
          ? el('div', { class: 'warn-box', style: 'margin-top:4px' },
              el('b', {}, 'This browser is blocking storage for this site. '),
              'That is why it asks again every time, and why it will not open without internet. ',
              'Tap the lock icon next to the address bar → Cookies and site data → allow this site.')
          : el('p', { class: 'hint' }, 'Your data stays on this device too — once signed in, the app works with no internet.'))
        : el('div', { class: 'warn-box' },
          el('b', {}, 'Setup not finished. '),
          'Open ', el('span', { class: 'mono' }, 'config.js'),
          ' and paste your Supabase project URL and anon key, then reload. Full steps are in ',
          el('span', { class: 'mono' }, 'SETUP.md'), '.'))));
}

// ------------------------------------------------------------ screen lock -
async function lockScreen() {
  const s = getSettings();
  if (!s.lock_hash) return true;
  if (safeStore('jinnyfin-unlocked', undefined, 'session') === '1') return true;
  return new Promise(res => {
    const root = $('#root'); root.innerHTML = '';
    const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: '••••', style: 'text-align:center;font-size:26px;letter-spacing:.5em' });
    const err = el('p', { class: 'small', style: 'color:var(--critical);min-height:18px' });
    const tryIt = async () => {
      if (await checkPin(pin.value, s.lock_salt, s.lock_hash)) {
        safeStore('jinnyfin-unlocked', '1', 'session'); res(true);
      } else { err.textContent = 'Wrong PIN'; pin.value = ''; }
    };
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') tryIt(); });
    root.append(el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' },
      el('h3', { style: 'margin-bottom:12px' }, '🔒 Enter your app PIN'), pin, err,
      el('button', { class: 'btn primary', style: 'width:100%;margin-top:10px', onclick: tryIt }, 'Unlock'))));
    setTimeout(() => pin.focus(), 60);
  });
}

// ------------------------------------------------------------------ boot ---
async function start() {
  applyTheme();
  if (!(await lockScreen())) return;
  await renderShell();
  await renderRoute();
  window.__jinnyfinReady = true;
  maybeNotify();
  startRinging();
  prefetchViews();
}

/**
 * Each screen is a separate module, fetched the first time you open it — which
 * is why that first tap felt slow. This pulls them all in once the app is idle,
 * so every later tap is instant and the app is complete for offline use.
 */
function prefetchViews() {
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
  idle(() => {
    for (const r of Object.values(ROUTES)) { try { r.load(); } catch { /* not fatal */ } }
  });
}

S.onChange(what => {
  updateChip();
  paintBell();
  if (what === 'auth') {
    if (!state.user) loginScreen(); else { start(); Push.refresh(); }
  } else if (what === 'data' && currentView?.refresh) {
    // Redrawing in place must not move anything. The page has one scrollbar but
    // the tables have their own, and a rebuild resets every one of them.
    const marks = captureScroll();
    try { currentView.refresh(); } catch (e) { console.warn(e); }
    restoreScroll(marks);
  }
});

/**
 * Remember where the page and every inner scroller sit. Each one is keyed by its
 * position in the tree, which survives a rebuild that produces the same shape.
 */
function captureScroll() {
  const marks = [{ path: null, top: window.scrollY, left: 0 }];
  const main = $('#main');
  if (main) {
    for (const n of main.querySelectorAll('*')) {
      if (n.scrollTop || n.scrollLeft) marks.push({ path: pathOf(n, main), top: n.scrollTop, left: n.scrollLeft });
    }
  }
  return marks;
}

function restoreScroll(marks) {
  const put = () => {
    const main = $('#main');
    for (const m of marks) {
      if (m.path === null) { if (window.scrollY !== m.top) window.scrollTo(0, m.top); continue; }
      const n = main && nodeAt(m.path, main);
      if (n) { n.scrollTop = m.top; n.scrollLeft = m.left; }
    }
  };
  put();
  requestAnimationFrame(put);          // again once the new rows have laid out
}

const pathOf = (n, root) => {
  const out = [];
  for (let c = n; c && c !== root; c = c.parentElement) out.unshift([...c.parentElement.children].indexOf(c));
  return out;
};
const nodeAt = (path, root) => path.reduce((n, i) => n?.children?.[i], root);

addEventListener('hashchange', renderRoute);

// Remember where each screen was left, so coming back lands there.
let scrollTick = 0;
addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = setTimeout(() => { scrollTick = 0; scrollMemo[route()] = window.scrollY; }, 150);
}, { passive: true });

addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openTxEditor(); }
  if (e.key === '/') { e.preventDefault(); go('transactions'); }
});

// ---------------------------------------------------- insurance reminder ---
async function maybeNotify() {
  const head = insuranceHeadline();
  if (head.level === 'ok' || head.level === 'none') return;
  const key = 'jinnyfin-notified-' + todayISO();
  if (safeStore(key)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const body = head.next ? `${head.next.label} — ${head.next.policy || ''} renews ${head.next.renewal_date}` : '';
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'jinnyfin-insurance' };
  if (reg) reg.showNotification('Jinnyfin · ' + head.text, opts); else new Notification('Jinnyfin · ' + head.text, opts);
  safeStore(key, '1');
}

(async function main() {
  window.__jinnyfinBooted = true;          // the boot guard in index.html watches this
  try {
    await S.boot();
  } catch (e) {
    console.error('[boot]', e);
    document.dispatchEvent(new CustomEvent('jinnyfin-boot-failed', { detail: e.message || String(e) }));
    return;
  }
  if (!state.user) {
    // Local data but no session (token expired, or Supabase not set up yet):
    // the app is still fully usable — it just cannot sync until you sign in.
    if (DB.transactions.length) start();
    else loginScreen();
  } else {
    start();
    if (!DB.transactions.length) S.sync({ full: true });
  }
})();

window.JINNYFIN = { S, DB, go, openTxEditor };
