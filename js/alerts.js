// ============================================================================
//  alerts.js — everything the app wants to tell you, in one list.
//
//  Three things raise an alert: a reminder you set yourself, a policy or
//  document about to expire, and a card about to run out. They arrive here as
//  one stream so the bell can carry a single honest count, and so "read",
//  "snoozed" and "done" mean the same thing whatever raised them.
//
//  Read/snooze state lives in settings (one small map keyed by alert id), which
//  means it syncs: mark something read on the phone and the PC agrees.
// ============================================================================
import { DB, getSettings, setSettings } from './store.js';
import { todayISO, daysBetween, iso } from './util.js';
import { insuranceAlerts } from './calc.js';

/** Everything about one alert's state that we keep between sessions. */
const seenMap = () => getSettings().alert_state || {};
const saveSeen = m => setSettings({ alert_state: m });

const nowISO = () => new Date().toISOString();

/** A stable id, so the same policy expiring is the same alert tomorrow. */
const keyFor = (kind, id, when) => `${kind}:${id}:${when || ''}`;

/**
 * A card is "expiring" from its printed MM/YY — it stops working at the end of
 * that month, so the last day of the month is the date that matters.
 */
function cardExpiry(c) {
  const m = String(c.expiry_hint || '').match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
  if (!m) return null;
  const mm = +m[1];
  let yy = +m[2];
  if (yy < 100) yy += 2000;
  if (!(mm >= 1 && mm <= 12)) return null;
  return new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);   // day 0 = last of mm
}

/** When a repeating task is next due after the one that just passed. */
export function nextDue(task) {
  if (!task.due_date || !task.repeat || task.repeat === 'none') return null;
  const [y, m, d] = task.due_date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (task.repeat === 'daily') dt.setUTCDate(dt.getUTCDate() + 1);
  else if (task.repeat === 'weekly') dt.setUTCDate(dt.getUTCDate() + 7);
  else if (task.repeat === 'monthly') dt.setUTCMonth(dt.getUTCMonth() + 1);
  else if (task.repeat === 'yearly') dt.setUTCFullYear(dt.getUTCFullYear() + 1);
  else return null;
  return dt.toISOString().slice(0, 10);
}

/** The moment a task actually falls due, as a comparable instant. */
export const dueAt = t => (t.due_date ? new Date(`${t.due_date}T${t.due_time || '09:00'}:00`) : null);

/**
 * The whole stream, newest trouble first.
 * @param {object} o
 * @param {boolean} o.all  include ones that are not due yet (the Reminders screen wants those)
 */
export function alerts({ all = false } = {}) {
  const seen = seenMap();
  const today = todayISO();
  const now = new Date();
  const out = [];

  const push = a => {
    const st = seen[a.id] || {};
    if (st.done) return;                                  // dealt with, gone for good
    if (st.snoozeUntil && new Date(st.snoozeUntil) > now && !all) return;
    out.push({ ...a, read: !!st.read, snoozeUntil: st.snoozeUntil || null });
  };

  // ── reminders you set yourself ───────────────────────────────────────────
  for (const t of DB.tasks || []) {
    if (t.deleted || t.done) continue;
    const at = dueAt(t);
    if (!at) continue;
    const late = Math.round((now - at) / 86400000);
    if (!all && at > now) continue;
    push({
      id: keyFor('task', t.id, t.due_date),
      kind: 'task', ref: t.id, title: t.title,
      body: t.note || '',
      when: t.due_date, time: t.due_time || null,
      overdue: at <= now, daysLeft: -late,
      level: at > now ? 'ok' : late >= 1 ? 'expired' : 'critical',
      priority: t.priority || 'normal',
      go: '#/tasks',
    });
  }

  // ── policies and documents ───────────────────────────────────────────────
  for (const p of insuranceAlerts(today)) {
    const within = p.daysLeft <= (p.notify_days || 30);
    if (!all && !within) continue;
    push({
      id: keyFor(p.kind === 'document' ? 'doc' : 'policy', p.id, p.renewal_date),
      kind: p.kind === 'document' ? 'doc' : 'policy', ref: p.id,
      title: p.daysLeft < 0
        ? `${p.label} expired ${-p.daysLeft} days ago`
        : `${p.label} renews in ${p.daysLeft} days`,
      body: [p.policy, p.policy_no].filter(Boolean).join(' · '),
      when: iso(p.renewal_date), daysLeft: p.daysLeft,
      overdue: p.daysLeft < 0, level: p.level,
      go: '#/insurance',
    });
  }

  // ── cards about to run out ───────────────────────────────────────────────
  for (const c of DB.cards || []) {
    if (c.deleted) continue;
    const on = cardExpiry(c);
    if (!on) continue;
    const daysLeft = daysBetween(today, on);
    if (!all && daysLeft > 45) continue;
    push({
      id: keyFor('card', c.id, on),
      kind: 'card', ref: c.id,
      title: daysLeft < 0
        ? `${c.label} expired ${-daysLeft} days ago`
        : `${c.label} expires in ${daysLeft} days`,
      body: [c.bank, c.last4 ? '•••• ' + c.last4 : null].filter(Boolean).join(' · '),
      when: on, daysLeft,
      overdue: daysLeft < 0,
      level: daysLeft < 0 ? 'expired' : daysLeft <= 14 ? 'critical' : 'soon',
      go: '#/insurance',
    });
  }

  const rank = { expired: 0, critical: 1, soon: 2, ok: 3 };
  return out.sort((a, b) =>
    (rank[a.level] ?? 9) - (rank[b.level] ?? 9) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
}

export const unreadCount = () => alerts().filter(a => !a.read).length;

// ── what you can do with one ───────────────────────────────────────────────
function mark(id, patch) {
  const m = { ...seenMap() };
  m[id] = { ...(m[id] || {}), ...patch };
  // Nothing older than a year is worth remembering the state of.
  const cut = Date.now() - 400 * 86400000;
  for (const k of Object.keys(m)) {
    if (m[k].at && new Date(m[k].at).getTime() < cut) delete m[k];
  }
  return saveSeen(m);
}
export const markRead = id => mark(id, { read: true, at: nowISO() });
export const markUnread = id => mark(id, { read: false, at: nowISO() });
export const snooze = (id, minutes) =>
  mark(id, { read: true, at: nowISO(), snoozeUntil: new Date(Date.now() + minutes * 60000).toISOString() });
export const dismiss = id => mark(id, { done: true, at: nowISO() });
export const markAllRead = () => {
  const m = { ...seenMap() };
  for (const a of alerts()) m[a.id] = { ...(m[a.id] || {}), read: true, at: nowISO() };
  return saveSeen(m);
};

/** Has this one ever been announced out loud on this device? */
const RUNG = 'jinnyfin-rung';
export function unrung() {
  let rung = [];
  try { rung = JSON.parse(localStorage.getItem(RUNG) || '[]'); } catch { rung = []; }
  const fresh = alerts().filter(a => !a.read && !rung.includes(a.id));
  if (fresh.length) {
    try {
      localStorage.setItem(RUNG, JSON.stringify([...rung, ...fresh.map(a => a.id)].slice(-200)));
    } catch { /* storage blocked — it will simply ring again, which is the safe way round */ }
  }
  return fresh;
}
