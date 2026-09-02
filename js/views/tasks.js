// ============================================================================
//  tasks.js — reminders you set yourself, and the inbox of everything the app
//  wants to tell you.
//
//  Two lists on one screen: what you asked to be reminded about, and what is
//  ringing right now (a policy, a card, an overdue reminder). The second list
//  is the same one behind the bell, so a thing marked read here is read there.
// ============================================================================
import { el, modal, toast, todayISO, fmtDate, confirmBox } from '../util.js';
import { DB, put, remove } from '../store.js';
import { topbar } from '../app.js';
import * as A from '../alerts.js';
import { kpi } from './report.js';

let host = null, filter = 'open';

const REPEATS = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'],
  ['monthly', 'Every month'], ['yearly', 'Every year']];
const PRIORITY = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];
const PRI_MARK = { high: '🔴', normal: '🔵', low: '⚪' };

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

const dueText = t => {
  if (!t.due_date) return 'No date';
  const at = A.dueAt(t);
  const days = Math.ceil((at - new Date()) / 86400000);
  const when = fmtDate(t.due_date) + (t.due_time ? ' · ' + t.due_time : '');
  if (t.done) return when;
  if (days < 0) return `${when} · ${-days} day${days === -1 ? '' : 's'} late`;
  if (days === 0) return `${when} · today`;
  if (days === 1) return `${when} · tomorrow`;
  return `${when} · in ${days} days`;
};

function draw() {
  host.innerHTML = '';
  const all = (DB.tasks || []).filter(t => !t.deleted);
  const open = all.filter(t => !t.done);
  const late = open.filter(t => { const d = A.dueAt(t); return d && d <= new Date(); });
  const ringing = A.alerts();

  host.append(topbar('Reminders',
    el('button', { class: 'btn sm primary', onclick: () => edit() }, '+ Reminder')));

  host.append(el('div', { class: 'grid g4 keep2' },
    kpi('Open', String(open.length)),
    kpi('Due now', String(late.length), late.length ? 'expense' : ''),
    kpi('Unread', String(ringing.filter(a => !a.read).length)),
    kpi('Done', String(all.length - open.length))));

  // ------------------------------------------------------------- inbox ----
  const inbox = el('div', { class: 'card', style: 'margin-top:12px' });
  inbox.append(el('div', { class: 'card-head' }, el('h3', {}, 'Ringing now'),
    el('div', { class: 'spacer' }),
    ringing.some(a => !a.read)
      ? el('button', { class: 'btn sm', onclick: async () => { await A.markAllRead(); draw(); } }, 'Mark all read')
      : null));
  if (!ringing.length) {
    inbox.append(el('p', { class: 'small muted', style: 'margin:0' }, 'Nothing needs you right now.'));
  } else {
    for (const a of ringing) inbox.append(alertRow(a, draw));
  }
  host.append(inbox);

  // ---------------------------------------------------------- my list -----
  const seg = el('div', { class: 'seg', style: 'margin:14px 0 10px' },
    ...[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([v, t]) =>
      el('button', { class: filter === v ? 'on' : '', onclick: () => { filter = v; draw(); } }, t)));
  host.append(seg);

  const list = all
    .filter(t => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done))
    .sort((x, y) => {
      if (!!x.done !== !!y.done) return x.done ? 1 : -1;
      return String(x.due_date || '9999').localeCompare(String(y.due_date || '9999'))
        || String(x.due_time || '').localeCompare(String(y.due_time || ''));
    });

  if (!list.length) {
    host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '⏰'),
      el('p', {}, filter === 'done' ? 'Nothing finished yet.' : 'No reminders set.'),
      el('button', { class: 'btn primary', onclick: () => edit() }, 'Set one')));
    return;
  }

  const box = el('div', { class: 'card' });
  for (const t of list) {
    const at = A.dueAt(t);
    const overdue = !t.done && at && at <= new Date();
    box.append(el('div', { class: 'task-row' + (t.done ? ' is-done' : '') },
      el('button', {
        class: 'task-tick' + (t.done ? ' on' : ''), title: t.done ? 'Not done after all' : 'Done',
        onclick: () => finish(t),
      }, t.done ? '✓' : ''),
      el('div', { style: 'min-width:0;flex:1;cursor:pointer', onclick: () => edit(t) },
        el('div', { class: 't1' }, PRI_MARK[t.priority] || '🔵', ' ', t.title),
        el('div', { class: 't2' + (overdue ? ' late' : '') },
          dueText(t),
          t.repeat && t.repeat !== 'none' ? ' · ↻ ' + t.repeat : '',
          t.note ? ' · ' + t.note : '')),
      el('button', { class: 'icon-btn', title: 'Edit', onclick: () => edit(t) }, '✎')));
  }
  host.append(box);
}

/** One line in the inbox, with everything you can do to it. */
export function alertRow(a, after) {
  const ICON = { task: '⏰', policy: '🛡️', doc: '🪪', card: '💳' };
  const row = el('div', { class: 'alert-row ' + a.level + (a.read ? '' : ' unread') });
  row.append(
    el('span', { class: 'ai' }, ICON[a.kind] || '🔔'),
    el('div', { style: 'min-width:0;flex:1;cursor:pointer', onclick: async () => {
      await A.markRead(a.id);
      location.hash = a.go;
    } },
      el('div', { class: 't1' }, a.title),
      el('div', { class: 't2' }, [a.body, a.when ? fmtDate(a.when) : null].filter(Boolean).join(' · '))),
    el('div', { class: 'alert-acts' },
      el('button', {
        class: 'icon-btn', title: a.read ? 'Mark unread' : 'Mark read',
        onclick: async () => { await (a.read ? A.markUnread(a.id) : A.markRead(a.id)); after?.(); },
      }, a.read ? '○' : '●'),
      el('button', {
        class: 'icon-btn', title: 'Snooze',
        onclick: async e => { e.stopPropagation(); await snoozeMenu(a); after?.(); },
      }, '💤'),
      el('button', {
        class: 'icon-btn', title: 'Stop telling me',
        onclick: async () => { await A.dismiss(a.id); toast('Stopped'); after?.(); },
      }, '✕')));
  return row;
}

async function snoozeMenu(a) {
  return new Promise(res => {
    const pick = async mins => { await A.snooze(a.id, mins); m.close(); toast('Snoozed'); res(); };
    const m = modal('Remind me again', el('div', { class: 'grid', style: 'gap:8px' },
      el('button', { class: 'btn', onclick: () => pick(10) }, 'In 10 minutes'),
      el('button', { class: 'btn', onclick: () => pick(60) }, 'In an hour'),
      el('button', { class: 'btn', onclick: () => pick(60 * 24) }, 'Tomorrow'),
      el('button', { class: 'btn', onclick: () => pick(60 * 24 * 7) }, 'Next week')));
  });
}

/** Ticking a repeating reminder rolls it forward instead of closing it. */
async function finish(t) {
  if (t.done) { await put('tasks', { ...t, done: false, done_at: null }); draw(); return; }
  const next = A.nextDue(t);
  if (next) {
    await put('tasks', { ...t, due_date: next });
    toast(`Done — next on ${fmtDate(next)}`, 'ok', 4000);
  } else {
    await put('tasks', { ...t, done: true, done_at: new Date().toISOString() });
    toast('Done');
  }
  draw();
}

function edit(v = null) {
  const isNew = !v;
  const t = v || { title: '', note: '', due_date: todayISO(),
    due_time: new Date(Date.now() + 3600000).toTimeString().slice(0, 5),
    repeat: 'none', priority: 'normal', done: false };

  const title = el('input', { value: t.title, placeholder: 'What should I remind you about?' });
  const note = el('input', { value: t.note || '', placeholder: 'Any detail (optional)' });
  const date = el('input', { type: 'date', value: t.due_date || todayISO() });
  const time = el('input', { type: 'time', value: t.due_time || '09:00' });
  const rep = el('select', {}, ...REPEATS.map(([v2, l]) => el('option', { value: v2, selected: (t.repeat || 'none') === v2 }, l)));
  const pri = el('select', {}, ...PRIORITY.map(([v2, l]) => el('option', { value: v2, selected: (t.priority || 'normal') === v2 }, l)));

  const field = (label, node, cls = '') =>
    el('div', { class: 'field ' + cls }, el('label', {}, label), node);

  const m = modal(isNew ? 'New reminder' : 'Edit reminder',
    el('div', { class: 'form-grid' },
      field('Reminder', title, 'full'),
      field('Date', date), field('Time', time),
      field('Repeat', rep), field('Priority', pri),
      field('Note', note, 'full')),
    { footer: [
      v ? el('button', {
        class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => {
          if (!(await confirmBox('Delete this reminder?'))) return;
          await remove('tasks', v.id); toast('Deleted'); m.close(); draw();
        },
      }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!title.value.trim()) { toast('Give it a name', 'warn'); title.focus(); return; }
        await put('tasks', { ...t, title: title.value.trim(), note: note.value.trim() || null,
          due_date: date.value || null, due_time: time.value || null,
          repeat: rep.value, priority: pri.value });
        toast(isNew ? 'Reminder set' : 'Updated'); m.close(); draw();
      } }, isNew ? 'Set reminder' : 'Save'),
    ].filter(Boolean) });
  setTimeout(() => title.focus(), 60);
}

export { edit as openTaskEditor };
