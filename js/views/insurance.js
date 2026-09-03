// ============================================================================
//  insurance.js — policies and documents that expire, with reminders.
// ============================================================================
import { el, money, fmtDate, todayISO, modal, toast, confirmBox, addDays, downloadCSV, daysBetween } from '../util.js';
import { DB, put, remove, getSettings, setSettings } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';
import * as P from '../push.js';

let host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  host.innerHTML = '';
  const rows = C.insuranceAlerts();
  const head = C.insuranceHeadline();
  host.append(topbar('Insurance & Documents',
    el('button', { class: 'btn sm', onclick: exportCSV }, '⬇ CSV')));

  // The headline already names one of them when something is close; the line
  // under it must then name the NEXT one — never skip the soonest.
  const sub = head.level === 'soon' || head.level === 'expired' ? head.then : head.next;
  host.append(el('div', { class: 'alert ' + head.level },
    el('span', { class: 'ico' }, head.level === 'ok' ? '✓' : head.level === 'expired' ? '⛔' : '⚠'),
    el('div', {}, el('b', {}, head.text),
      sub ? el('div', { class: 'small muted' },
        `next: ${sub.label} on ${fmtDate(sub.renewal_date)} · ${sub.daysLeft} days`) : null)));

  host.append(notifyCard());

  const cards = (DB.cards || []).filter(c => !c.deleted).map(c => ({ ...c, ...cardDue(c) }))
    .sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
  const expired = rows.filter(r => r.level === 'expired').length + cards.filter(c => c.daysLeft < 0).length;
  const soon = rows.filter(r => r.level === 'soon' || r.level === 'critical').length
    + cards.filter(c => c.daysLeft >= 0 && c.daysLeft <= 45).length;

  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' },
    kpi('Tracked', String(rows.length + cards.length)),
    kpi('Expiring soon', String(soon), soon ? 'expense' : ''),
    kpi('Already expired', String(expired), expired ? 'expense' : ''),
    kpi('Annual premium', money(rows.reduce((s, r) => s + (r.currency === 'SAR' ? (+r.premium || 0) * C.rates().sar : +r.premium || 0), 0), 'INR', false))));

  // Three things expire in this house: policies, papers, and plastic. Each gets
  // its own heading and its own Add, so nothing has to be hunted for.
  section('🛡️', 'Insurance policies', rows.filter(r => r.kind !== 'document'),
    'No policies yet.', () => edit(null, 'insurance'));
  section('🪪', 'ID & Documents', rows.filter(r => r.kind === 'document'),
    'No documents yet — Iqama, passport, licence.', () => edit(null, 'document'));
  cardSection(cards);
}

/** One headed block of expiring things. */
function section(icon, title, list, empty, add) {
  const head = el('div', { class: 'card-head', style: 'margin:18px 0 8px' },
    el('h3', {}, icon + '  ' + title),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn sm', onclick: add }, '+ Add'));
  host.append(head);
  if (!list.length) {
    host.append(el('p', { class: 'small muted', style: 'margin:0 2px 4px' }, empty));
    return;
  }
  const grid = el('div', { class: 'grid g2' });
  for (const p of list) {
    const badge = p.level === 'expired' ? ['⛔', 'var(--critical)', `expired ${-p.daysLeft} days ago`]
      : p.level === 'critical' ? ['🚨', 'var(--serious)', `${p.daysLeft} days left`]
      : p.level === 'soon' ? ['⚠', 'var(--warning)', `${p.daysLeft} days left`]
      : ['✓', 'var(--good)', `${p.daysLeft} days left`];
    grid.append(el('div', { class: 'card', style: `border-left:4px solid ${badge[1]};cursor:pointer`, onclick: () => edit(p) },
      el('div', { class: 'row' },
        el('span', { style: 'font-size:18px' }, badge[0]),
        el('div', { style: 'min-width:0' }, el('b', {}, p.label),
          el('div', { class: 'small muted' }, p.policy || '')),
        el('div', { class: 'spacer' }),
        el('div', { style: 'text-align:right' },
          el('div', { class: 'small' }, fmtDate(p.renewal_date)),
          el('div', { class: 'small muted' }, badge[2]))),
      p.premium ? el('div', { class: 'small muted', style: 'margin-top:6px' },
        `Premium ${money(p.premium, p.currency || 'INR')} · reminder ${p.notify_days || 30} days before`) : null,
      p.policy_no ? el('div', { class: 'small muted mono' }, p.policy_no) : null));
  }
  host.append(grid);
}

/** When a card printed MM/YY actually stops working: the end of that month. */
function cardDue(c) {
  const m = String(c.expiry_hint || '').match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/);
  if (!m) return { on: null, daysLeft: null, level: 'none' };
  const mm = +m[1]; let yy = +m[2]; if (yy < 100) yy += 2000;
  if (!(mm >= 1 && mm <= 12)) return { on: null, daysLeft: null, level: 'none' };
  const on = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const daysLeft = daysBetween(todayISO(), on);
  return { on, daysLeft, level: daysLeft < 0 ? 'expired' : daysLeft <= 14 ? 'critical' : daysLeft <= 45 ? 'soon' : 'ok' };
}

/** The cards, by when they run out. The numbers stay locked in the vault. */
function cardSection(cards) {
  host.append(el('div', { class: 'card-head', style: 'margin:18px 0 8px' },
    el('h3', {}, '💳  ATM Cards'),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn sm', onclick: () => { location.hash = '#/cards'; } }, 'Open vault')));
  if (!cards.length) {
    host.append(el('p', { class: 'small muted', style: 'margin:0 2px 4px' },
      'No cards yet — add them in the Card Vault, where the numbers are encrypted.'));
    return;
  }
  const grid = el('div', { class: 'grid g2' });
  for (const c of cards) {
    const badge = c.level === 'expired' ? ['⛔', 'var(--critical)', `expired ${-c.daysLeft} days ago`]
      : c.level === 'critical' ? ['🚨', 'var(--serious)', `${c.daysLeft} days left`]
      : c.level === 'soon' ? ['⚠', 'var(--warning)', `${c.daysLeft} days left`]
      : c.level === 'none' ? ['💳', 'var(--hair)', 'no expiry saved']
      : ['✓', 'var(--good)', `${c.daysLeft} days left`];
    grid.append(el('div', { class: 'card', style: `border-left:4px solid ${badge[1]};cursor:pointer`,
      onclick: () => { location.hash = '#/cards'; } },
      el('div', { class: 'row' },
        el('span', { style: 'font-size:18px' }, badge[0]),
        el('div', { style: 'min-width:0' }, el('b', {}, c.label),
          el('div', { class: 'small muted' },
            [c.bank, c.network, c.last4 ? '•••• ' + c.last4 : null].filter(Boolean).join(' · '))),
        el('div', { class: 'spacer' }),
        el('div', { style: 'text-align:right' },
          el('div', { class: 'small' }, c.expiry_hint || '—'),
          el('div', { class: 'small muted' }, badge[2])))));
  }
  host.append(grid);
}

/**
 * Reminders that arrive with the app shut.
 *
 * Everything above this row only works while Jinnyfin is open on screen — a
 * page that is not running cannot ring. This row hands the phone itself the
 * job: it agrees to listen, and a job on the server pokes it every few minutes
 * whether the app is open, in the background, or closed for a week.
 *
 * Per device on purpose. The phone and the PC each say yes for themselves, so
 * turning it off on the office machine does not silence the phone.
 */
function pushRow() {
  const row = el('div', { class: 'row switch-row', style: 'margin-top:8px' });
  const body = el('div', { style: 'min-width:0;flex:1' });
  const acts = el('div', { class: 'row', style: 'gap:6px' });
  row.append(el('span', {}, '📲'), body, el('div', { class: 'spacer' }), acts);

  const paint = async () => {
    body.replaceChildren(el('b', {}, 'Push to this device'));
    acts.replaceChildren();
    const say = t => body.append(el('div', { class: 'small muted' }, t));

    if (!P.supported()) return say('This browser cannot receive notifications with the app closed.');
    if (!P.configured()) return say('Not set up yet — see PUSH-SETUP.md in the repo.');

    const sub = await P.current();
    const installed = matchMedia?.('(display-mode: standalone)').matches;
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (sub) {
      say('On. Reminders reach this device even when Jinnyfin is closed.');
      acts.append(el('button', { class: 'btn sm', onclick: async () => {
        const r = await P.test();
        toast(r.ok ? '📲 ' + r.why : r.why, r.ok ? 'ok' : 'warn', 7000);
      } }, 'Test'),
      el('button', { class: 'btn sm ghost', onclick: async () => {
        if (!(await confirmBox('Stop sending notifications to this device?'))) return;
        await P.disable(); toast('Stopped on this device'); paint();
      } }, 'Turn off'));
      return;
    }

    // iOS will not offer push to a page running in a Safari tab — the app has
    // to be on the Home Screen first. Saying so beats a button that fails.
    if (isIOS && !installed) {
      return say('On iPhone this needs the app added to the Home Screen first — '
        + 'Share → Add to Home Screen, then open it from there and come back.');
    }
    say('Off. Reminders only ring while the app is open on this device.');
    acts.append(el('button', { class: 'btn sm primary', onclick: async () => {
      const r = await P.enable();
      toast(r.why, r.ok ? 'ok' : 'warn', 8000);
      paint();
    } }, 'Turn on'));
  };
  paint();
  return row;
}

// -------------------------------------------------------- notifications ---
/**
 * A switch, not a mirror. What it shows is YOUR choice, kept in settings and
 * synced to every device — before, it read the browser's permission back to
 * you, so it looked as though it had turned itself off again.
 */
function notifyCard() {
  const s = getSettings();
  const on = s.notify_on !== false;                 // never asked = on
  const sound = s.reminder_sound !== false;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const blocked = on && supported && perm === 'denied';
  const needsAsking = on && supported && perm === 'default';

  const sw = el('input', { type: 'checkbox', checked: on });
  sw.addEventListener('change', async () => {
    const want = sw.checked;
    await setSettings({ notify_on: want });
    // Turning it on is also the moment to ask the browser, once.
    if (want && supported && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    toast(want ? 'Reminders on' : 'Reminders off');
    draw();
  });

  const sndSw = el('input', { type: 'checkbox', checked: sound });
  sndSw.addEventListener('change', async () => {
    await setSettings({ reminder_sound: sndSw.checked });
    toast(sndSw.checked ? 'Sound on' : 'Sound off');
  });

  const card = el('div', { class: 'card tight' });
  card.append(el('label', { class: 'row switch-row', style: 'cursor:pointer' },
    el('span', {}, '🔔'),
    el('div', { style: 'min-width:0' }, el('b', {}, 'Renewal reminders'),
      el('div', { class: 'small muted' },
        !on ? 'Off — nothing will be announced until you switch this back on.'
          : !supported ? 'On inside the app. This browser cannot show system pop-ups.'
          : blocked ? 'On inside the app — but your browser is blocking pop-ups for this site. Allow notifications in the site settings.'
          : needsAsking ? 'On inside the app. Tap “Allow pop-ups” to get them outside it too.'
          : 'On — you get a pop-up when something falls due.')),
    el('div', { class: 'spacer' }), sw));

  card.append(el('label', { class: 'row switch-row', style: 'cursor:pointer;margin-top:8px' },
    el('span', {}, '🔊'),
    el('div', { style: 'min-width:0' }, el('b', {}, 'Sound'),
      el('div', { class: 'small muted' }, 'A short chime when a reminder rings inside the app.')),
    el('div', { class: 'spacer' }), sndSw));

  card.append(pushRow());

  const acts = el('div', { class: 'row', style: 'margin-top:8px' });
  if (needsAsking || blocked) {
    acts.append(el('button', {
      class: 'btn sm primary', onclick: async () => {
        const r = await Notification.requestPermission();
        toast(r === 'granted' ? 'Pop-ups allowed' : 'Your browser said no — allow it in the site settings', r === 'granted' ? 'ok' : 'warn', 5000);
        draw();
      },
    }, 'Allow pop-ups'));
  }
  if (on) {
    acts.append(el('button', {
      class: 'btn sm', onclick: async () => {
        const head = C.insuranceHeadline();
        const body = head.next ? `${head.next.label} renews ${fmtDate(head.next.renewal_date)}` : 'Nothing due soon.';
        const reg = await navigator.serviceWorker?.getRegistration();
        if (supported && Notification.permission === 'granted') {
          const opts = { body, icon: 'icons/icon-192.png', tag: 'jinnyfin-test' };
          if (reg) reg.showNotification('Jinnyfin · ' + head.text, opts);
          else new Notification('Jinnyfin · ' + head.text, opts);
        }
        toast('🔔 ' + head.text + ' — ' + body, 'ok', 6000);
      },
    }, 'Test it'));
  }
  if (acts.children.length) card.append(acts);

  card.append(el('p', { class: 'hint', style: 'margin:8px 0 0' },
    'Want an e-mail too? The repo ships a GitHub Action ('
    , el('span', { class: 'mono' }, '.github/workflows/expiry-email.yml')
    , ') that checks every morning and mails you — see SETUP.md.'));
  return card;
}

const printableDate = () => todayISO();

function edit(p = null, startKind = 'insurance') {
  const v = p || { label: '', policy: '', policy_no: '', renewal_date: addDays(todayISO(), 365),
    premium: 0, currency: 'INR', notify_days: 30, kind: startKind, note: '' };
  const label = el('input', { value: v.label, placeholder: 'Car / Health / Iqama / Passport' });
  const policy = el('input', { value: v.policy || '', placeholder: 'Insurer or issuing body' });
  const pno = el('input', { value: v.policy_no || '', placeholder: 'Policy / document number' });
  const date = el('input', { type: 'date', value: v.renewal_date });
  const prem = el('input', { type: 'number', step: 'any', value: v.premium || 0 });
  // The premium is paid out of an account, so it is in that account's currency.
  // A free choice here silently valued a riyal premium as rupees.
  const cur = el('input', { readonly: true, tabindex: '-1', class: 'locked', value: v.currency || 'INR' });
  const days = el('input', { type: 'number', value: v.notify_days || 30 });
  const kind = el('select', {}, el('option', { value: 'insurance', selected: v.kind !== 'document' }, 'Insurance policy'),
    el('option', { value: 'document', selected: v.kind === 'document' }, 'Document (Iqama, passport, licence…)'));
  const note = el('input', { value: v.note || '' });
  // Renewing is a payment. It should leave an account, like every other payment.
  const payFrom = el('select', {}, ...C.activeAccounts()
    .map(a => el('option', { value: a.name, selected: v.pay_account === a.name }, `${a.name} · ${a.currency}`)));
  if (!v.pay_account) payFrom.value = C.cashAccounts()[0]?.name || payFrom.value;
  const followAccount = () => { cur.value = C.currencyOf(payFrom.value) || cur.value; };
  payFrom.addEventListener('change', followAccount);
  followAccount();
  const postIt = el('input', { type: 'checkbox', checked: true });
  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const body = el('div', { class: 'form-grid' },
    fld('Short label', label), fld('Type', kind),
    fld('Provider / policy', policy, 'full'),
    fld('Policy / document no.', pno, 'full'),
    fld('Renews / expires on', date), fld('Remind me days before', days),
    fld('Premium', prem), fld('Currency', cur),
    fld('Pay from', payFrom, 'full'),
    el('label', { class: 'field full row', style: 'flex-direction:row;gap:8px;align-items:center' },
      postIt, ' Record the premium as a transaction when I renew'),
    fld('Note', note, 'full'));
  const m = modal(p ? 'Edit policy' : 'New policy', body, {
    footer: [
      p ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Remove this policy?')) { await remove('insurance', p.id); m.close(); } } }, 'Delete') : null,
      p ? el('button', { class: 'btn', onclick: () => renew(v, m, {
        premium: +prem.value || 0, currency: cur.value, account: payFrom.value,
        record: postIt.checked, label: label.value.trim() || v.label,
      }) }, '↻ Renewed +1 yr') : null,
      el('button', { class: 'btn primary', onclick: async () => {
        if (!label.value.trim()) return toast('Give it a label', 'warn');
        await put('insurance', { ...v, label: label.value.trim(), policy: policy.value.trim(),
          policy_no: pno.value.trim(), renewal_date: date.value, premium: +prem.value || 0,
          currency: cur.value, notify_days: +days.value || 30, kind: kind.value, note: note.value.trim() });
        m.close();
      } }, 'Save'),
    ].filter(Boolean),
  });
}

function exportCSV() {
  downloadCSV(`jinnyfin-policies-${todayISO()}.csv`,
    [['Label', 'Type', 'Provider', 'Number', 'Renewal date', 'Days left', 'Premium', 'Currency'],
      ...C.insuranceAlerts().map(p => [p.label, p.kind, p.policy || '', p.policy_no || '', p.renewal_date, p.daysLeft, p.premium || 0, p.currency || 'INR'])]);
}
