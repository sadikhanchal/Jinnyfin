// ============================================================================
//  jinnyfin-push — the part that rings when the app is shut.
//
//  A scheduled job pokes this every five minutes. It looks for anything due:
//  a reminder whose time has come, a policy or document near its renewal, a
//  card near its expiry. For each one it posts an encrypted message to every
//  device that has said it will listen, and the phone's own software shows the
//  notification and plays the phone's notification sound.
//
//  Two rules keep it quiet and honest:
//    · anything already sent is written to push_log, so a reminder rings once
//      and not every five minutes until it is dealt with;
//    · anything the person has snoozed, dismissed or already read in the app is
//      skipped, because that state lives in the settings row and is read here
//      too. The bell in the app and the notification on the lock screen are
//      looking at the same list.
//
//  It runs with the service key, so it can see every user's rows. That key is
//  set as a secret on this function and exists nowhere else — not in the app,
//  not in the repository.
// ============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:sadikhanchal@gmail.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------- clocks ---
// This server keeps UTC. The person does not. A reminder written as 11:45 means
// 11:45 on the wall where they are standing, so every date and time out of the
// database has to be read through their zone or the whole thing fires hours out.
// The app writes that zone into settings each time it starts, which is also what
// makes reminders follow you when you change country.
const FALLBACK_TZ = 'Asia/Riyadh';

/** Minutes this zone is ahead of UTC at that instant — DST included. */
function zoneOffset(tz: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map(x => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - at.getTime()) / 60000);
}

/** "2026-09-04" + "11:45" in their zone → the real moment it happens. */
function instantAt(date: string, time: string, tz: string): number {
  const naive = Date.parse(`${date}T${time}:00Z`);        // read as though UTC
  if (Number.isNaN(naive)) return NaN;
  // Subtract the offset, then check it again from where that landed: on the two
  // days a year a zone shifts, the first guess can sit on the wrong side of the
  // change and be an hour out.
  const once = naive - zoneOffset(tz, new Date(naive)) * 60000;
  return naive - zoneOffset(tz, new Date(once)) * 60000;
}

/** Today's date where they are, which is not always today's date here. */
function localToday(tz: string, at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(at).map(x => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/** The same key the app's bell uses, so both agree what "this alert" is. */
const keyFor = (kind: string, id: string, when?: string) => `${kind}:${id}:${when || ''}`;

type Push = { key: string; title: string; body: string; url: string };

/**
 * A card stops working at the END of its printed month, so the last day of that
 * month is the date that matters. Same rule as the app.
 */
function cardExpiry(hint?: string): string | null {
  const m = String(hint || '').match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
  if (!m) return null;
  const mm = +m[1];
  let yy = +m[2];
  if (yy < 100) yy += 2000;
  if (!(mm >= 1 && mm <= 12)) return null;
  return new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
}

/** Everything that should ring for one person, right now. */
async function dueFor(userId: string, now: Date): Promise<Push[]> {
  const out: Push[] = [];

  // What the person has already dealt with in the app: read, snoozed, stopped.
  const { data: settings } = await db.from('settings').select('data').eq('user_id', userId).limit(1);
  const s = settings?.[0]?.data || {};
  if (s.notify_on === false) return [];                 // reminders switched off

  // Their clock, not the server's. Everything below is measured against it.
  const tz = s.tz || FALLBACK_TZ;
  const today = localToday(tz, now);
  const seen: Record<string, { read?: boolean; snoozed_to?: string; dismissed?: boolean }> =
    s.alert_state || {};
  const skip = (key: string) => {
    const st = seen[key];
    if (!st) return false;
    if (st.dismissed) return true;
    if (st.snoozed_to && Date.parse(st.snoozed_to) > now.getTime()) return true;
    return false;
  };

  // ---- reminders you set yourself ----------------------------------------
  const { data: tasks } = await db.from('tasks').select('*')
    .eq('user_id', userId).eq('deleted', false).eq('done', false);
  for (const t of tasks || []) {
    if (!t.due_date) continue;
    const at = instantAt(t.due_date, t.due_time || '09:00', tz);
    if (!(at <= now.getTime())) continue;               // not yet
    const key = keyFor('task', t.id, t.due_date);
    if (skip(key)) continue;
    // Calendar days in their zone, so the wording here matches the app's.
    const late = -daysBetween(today, t.due_date);
    out.push({ key, title: t.title,
      body: late > 0 ? `${late} day${late === 1 ? '' : 's'} late` + (t.note ? ` · ${t.note}` : '')
        : (t.note || 'Due now'),
      url: './#/tasks' });
  }

  // ---- policies and documents --------------------------------------------
  const { data: pol } = await db.from('insurance').select('*')
    .eq('user_id', userId).eq('deleted', false);
  for (const p of pol || []) {
    if (!p.renewal_date) continue;
    const left = daysBetween(today, String(p.renewal_date).slice(0, 10));
    if (left > (p.notify_days ?? 30)) continue;
    const key = keyFor(p.kind === 'document' ? 'doc' : 'policy', p.id, p.renewal_date);
    if (skip(key)) continue;
    out.push({ key,
      title: `${p.label}${p.kind === 'document' ? ' — document' : ''}`,
      body: left < 0 ? `expired ${-left} day${left === -1 ? '' : 's'} ago`
        : left === 0 ? 'expires today' : `${left} day${left === 1 ? '' : 's'} left`,
      url: './#/insurance' });
  }

  // ---- cards about to run out --------------------------------------------
  const { data: cards } = await db.from('cards').select('*')
    .eq('user_id', userId).eq('deleted', false);
  for (const c of cards || []) {
    const on = cardExpiry(c.expiry_hint);
    if (!on) continue;
    const left = daysBetween(today, on);
    if (left > 45) continue;
    const key = keyFor('card', c.id, on);
    if (skip(key)) continue;
    out.push({ key, title: `${c.label} card`,
      body: left < 0 ? `expired ${-left} days ago` : `expires in ${left} days`,
      url: './#/cards' });
  }

  return out;
}

/** Post one message to one device. Returns false when the device is gone. */
async function send(sub: any, payload: unknown): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 24 * 3600, urgency: 'high' },
    );
    return true;
  } catch (e: any) {
    // 404 / 410 mean the browser threw the subscription away — uninstalled, or
    // notifications turned off. Stop writing to a dead address.
    const code = e?.statusCode || e?.status;
    if (code === 404 || code === 410) {
      await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    } else {
      await db.from('push_subscriptions')
        .update({ failures: (sub.failures || 0) + 1 }).eq('endpoint', sub.endpoint);
      console.error('push failed', code, e?.body || e?.message);
    }
    return false;
  }
}

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  let body: any = {};
  try { body = await req.json(); } catch { /* the cron job sends nothing useful */ }

  // Both cron (no body) and app test requests (body.test + body.endpoint) are allowed.
  // The function uses service_role_key internally, so explicit auth here is unnecessary.

  // ---- "Test it" from inside the app -------------------------------------
  // Every device this person has switched on, not only the one that pressed the
  // button — a real reminder goes to all of them, so the test has to as well or
  // it is proving the wrong thing. The endpoint that asked only says who it is.
  if (body?.test && body?.endpoint) {
    const { data: who } = await db.from('push_subscriptions').select('user_id')
      .eq('endpoint', body.endpoint).limit(1);
    if (!who?.length) return new Response(JSON.stringify({ error: 'not subscribed' }),
      { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });

    const { data: subs } = await db.from('push_subscriptions').select('*')
      .eq('user_id', who[0].user_id).eq('deleted', false);
    let ok = 0;
    for (const s of subs || []) {
      if (await send(s, {
        title: 'Jinnyfin', body: 'Push is working — this is what a reminder will look like.',
        url: './#/tasks', tag: 'jinnyfin-test',
      })) ok++;
    }
    return new Response(JSON.stringify({ sent: ok, devices: subs?.length || 0 }),
      { status: ok ? 200 : 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // ---- the scheduled sweep ------------------------------------------------
  const now = new Date();
  const { data: subs } = await db.from('push_subscriptions').select('*').eq('deleted', false);
  const byUser = new Map<string, any[]>();
  for (const s of subs || []) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id)!.push(s);
  }

  let sent = 0, considered = 0;
  for (const [userId, devices] of byUser) {
    const due = await dueFor(userId, now);
    considered += due.length;
    if (!due.length) continue;

    // Which of these has this person already been told about?
    const keys = due.map(d => d.key);
    const { data: already } = await db.from('push_log')
      .select('alert_key').eq('user_id', userId).in('alert_key', keys);
    const told = new Set((already || []).map(r => r.alert_key));
    const fresh = due.filter(d => !told.has(d.key));
    if (!fresh.length) continue;

    // Several things at once become one line, not a pile of buzzes.
    const payload = fresh.length === 1
      ? { title: `Jinnyfin · ${fresh[0].title}`, body: fresh[0].body, url: fresh[0].url,
          tag: 'jinnyfin-' + fresh[0].key }
      : { title: `Jinnyfin · ${fresh.length} things need you`,
          body: fresh.slice(0, 4).map(d => `${d.title} — ${d.body}`).join('\n'),
          url: './#/tasks', tag: 'jinnyfin-digest' };

    let anyLanded = false;
    for (const d of devices) if (await send(d, payload)) { anyLanded = true; sent++; }

    // Only write it down once it actually left. If every device refused, the
    // next sweep should try again rather than quietly forget the reminder.
    if (anyLanded) {
      await db.from('push_log').upsert(
        fresh.map(d => ({ user_id: userId, alert_key: d.key, sent_at: now.toISOString() })),
        { onConflict: 'user_id,alert_key' });
    }
  }

  // Old log lines are of no use to anyone; keep the table from growing forever.
  const cutoff = new Date(now.getTime() - 120 * 86400000).toISOString();
  await db.from('push_log').delete().lt('sent_at', cutoff);

  return new Response(JSON.stringify({ ok: true, users: byUser.size, considered, sent }),
    { headers: { ...cors, 'Content-Type': 'application/json' } });
});
