// ============================================================================
//  push.js — reminders that arrive with the app shut.
//
//  The bell inside the app can only ring while the app is open. A push
//  subscription is the phone itself agreeing to listen: the browser hands us an
//  address on Google's push service, we hand that address to Supabase, and a
//  job on the server posts to it. The phone's operating system shows the
//  notification and plays its own notification sound — the same one every other
//  app on the phone uses. There is no way to choose a different sound from a web
//  app; that setting lives in the phone, per app, and you can change it there.
// ============================================================================
import { CONFIG } from '../config.js';
import { state, initSupabase, getSettings, setSettings } from './store.js';

/** The push service wants the key as raw bytes, not as text. */
function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Can this browser do push at all? */
export const supported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Configured? Without a key there is nothing to subscribe to. */
export const configured = () => !!(CONFIG.VAPID_PUBLIC_KEY || '').trim();

/** A name for this device, so several of them can be told apart in the list. */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone'
      : /Windows/i.test(ua) ? 'Windows'
        : /Mac OS X/i.test(ua) ? 'Mac' : 'This device';
  const app = /EdgA?\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const installed = matchMedia?.('(display-mode: standalone)').matches ? ' · installed' : '';
  return `${os} · ${app}${installed}`;
}

/** The subscription this browser already holds, or null. */
export async function current() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) || null;
}

/**
 * Ask the phone to listen, then tell the server where to knock.
 * Returns { ok, why } — `why` is something a person can read.
 */
export async function enable() {
  if (!supported()) return { ok: false, why: 'This browser cannot do push notifications.' };
  if (!configured()) return { ok: false, why: 'No push key is set in config.js yet — see PUSH-SETUP.md.' };
  if (!state.user) return { ok: false, why: 'Sign in first, so the reminder knows whose it is.' };

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return { ok: false, why: perm === 'denied'
      ? 'Your browser is blocking notifications for this site. Allow them in the site settings and try again.'
      : 'Notifications were not allowed.' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      // Chrome refuses a silent subscription — every push must show something.
      // That suits us: every push we send is a reminder worth seeing.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY.trim()),
    });
  }
  const saved = await save(sub);
  return saved.ok ? { ok: true, why: 'This device will now be told, even with the app closed.' } : saved;
}

/** Hand the address to Supabase, replacing whatever this device said before. */
async function save(sub) {
  const sb = await initSupabase();
  if (!sb || !state.user) return { ok: false, why: 'Not signed in.' };
  const j = sub.toJSON();
  const row = {
    user_id: state.user.id,
    endpoint: sub.endpoint,
    p256dh: j.keys?.p256dh || b64(sub.getKey('p256dh')),
    auth: j.keys?.auth || b64(sub.getKey('auth')),
    label: deviceLabel(),
    last_seen: new Date().toISOString(),
    failures: 0,
    deleted: false,
  };
  const { error } = await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (error) return { ok: false, why: 'Could not save it: ' + error.message };
  return { ok: true };
}

/** Stop this one device. Other devices carry on. */
export async function disable() {
  const sub = await current();
  if (!sub) return { ok: true };
  const sb = await initSupabase();
  if (sb) await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
  return { ok: true };
}

/**
 * Keep the stored address fresh. A push service may quietly hand the browser a
 * new endpoint; if we never told the server, reminders would stop arriving and
 * nothing would say why. Cheap to call on every start.
 */
export async function refresh() {
  try {
    if (!supported() || !configured() || !state.user) return;
    if (Notification.permission !== 'granted') return;
    const sub = await current();
    if (sub) await save(sub);
  } catch { /* never let this get in the way of the app starting */ }
}

/**
 * Tell the server which clock you keep.
 *
 * The server runs on UTC and has no other way of knowing. Without this a
 * reminder set for 11:45 in Jeddah arrives at 14:45; with it, 11:45 means 11:45
 * wherever you are standing — so open the app once after landing in another
 * country and everything you already set moves onto that country's clock. It
 * keeps its wall-clock time: a 7 am reminder is 7 am there, not 7 am back home.
 *
 * Written only when it actually changes, so it costs nothing on a normal start.
 */
export async function syncZone() {
  try {
    if (!state.user) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || getSettings().tz === tz) return;
    await setSettings({ tz });
  } catch { /* never let this get in the way of the app starting */ }
}

/** Ask the server to post one to this device right now, as a test. */
export async function test() {
  const sb = await initSupabase();
  if (!sb || !state.user) return { ok: false, why: 'Sign in first.' };
  const sub = await current();
  if (!sub) return { ok: false, why: 'This device is not listening yet.' };
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/jinnyfin-push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      apikey: CONFIG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || CONFIG.SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ test: true, endpoint: sub.endpoint }),
  }).catch(e => ({ ok: false, statusText: e.message }));
  if (!res.ok) {
    return { ok: false, why: res.status === 404
      ? 'The jinnyfin-push function is not deployed yet — see PUSH-SETUP.md.'
      : `The server said: ${res.status} ${res.statusText || ''}`.trim() };
  }
  // The server rings every device you have switched on, not just this one, so
  // say how many — that is the whole point of pressing Test.
  const out = await res.json().catch(() => ({}));
  const n = Number(out.sent) || 1;
  return { ok: true, why: n > 1
    ? `Sent to all ${n} of your devices — they should arrive in a moment.`
    : 'Sent — it should arrive in a moment.' };
}
