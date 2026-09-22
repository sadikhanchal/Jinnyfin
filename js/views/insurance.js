// ============================================================================
//  insurance.js — policies and documents that expire, with reminders.
// ============================================================================
import { el, money, fmtDate, todayISO, modal, toast, confirmBox, addDays, downloadCSV, daysBetween,
  uuid, badYear, dateBox, searchSelect, closeThen, round2 } from '../util.js';
import { DB, put, putMany, remove, getSettings, setSettings } from '../store.js';
import * as F from '../files.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';
import * as P from '../push.js';
import { icon } from '../icons.js';

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

  // Policies that are not tied to a category yet. Until they are, Renew has
  // nowhere to file the premium and the card cannot show what was paid.
  const unlinked = rows.filter(r => r.kind !== 'document' && !r.parent);
  if (unlinked.length) {
    host.append(el('div', { class: 'alert soon', style: 'margin-top:12px' },
      el('span', { class: 'ico' }, icon('link', 16)),
      el('div', { style: 'flex:1' },
        el('b', {}, `${unlinked.length} ${unlinked.length === 1 ? 'policy is' : 'policies are'} not linked to an Expense category`),
        el('div', { class: 'small muted' }, unlinked.map(r => r.label).join(' · '))),
      el('button', { class: 'btn sm primary', onclick: linkScreen }, 'Link them')));
  }

  const cards = (DB.cards || []).filter(c => !c.deleted).map(c => ({ ...c, ...cardDue(c) }))
    .sort((a, b) => (a.daysLeft ?? 9e9) - (b.daysLeft ?? 9e9));
  // A card with its reminders off still wears its ⚠ / ⛔, but it is not
  // counted as needing attention up here.
  const loud = rows.filter(r => !r.muted);
  const expired = loud.filter(r => r.level === 'expired').length + cards.filter(c => c.daysLeft < 0).length;
  const soon = loud.filter(r => r.level === 'soon' || r.level === 'critical').length
    + cards.filter(c => c.daysLeft >= 0 && c.daysLeft <= 45).length;
  // A year's worth of each premium: a quarterly ₹5,828 is ₹23,312 a year, not ₹5,828.
  const annual = rows.reduce((s, r) => {
    const prem = +r.premium || 0;
    if (!prem) return s;
    const t = C.termOf(r);
    const yearly = t ? prem * 12 / t : prem;
    return s + (r.currency === 'SAR' ? yearly * C.rates().sar : yearly);
  }, 0);

  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' },
    kpi('Tracked', String(rows.length + cards.length)),
    kpi('Expiring soon', String(soon), soon ? 'expense' : ''),
    kpi('Already expired', String(expired), expired ? 'expense' : ''),
    kpi('Annual premium', money(annual, 'INR', false))));

  // Three things expire in this house: policies, papers, and plastic. Each gets
  // its own heading and its own Add, so nothing has to be hunted for.
  section('shield', 'Insurance policies', rows.filter(r => r.kind !== 'document'),
    'No policies yet.', () => edit(null, 'insurance'),
    el('button', { class: 'btn sm ghost', title: 'Link policies to their Expense sub-categories', onclick: linkScreen },
      icon('link', 14), ' Links'));
  section('id', 'ID & Documents', rows.filter(r => r.kind === 'document'),
    'No documents yet — Iqama, passport, licence.', () => edit(null, 'document'));
  cardSection(cards);
}

/** "Insurance › Health Insurance" — or null for a card with no link. */
const linkName = p => (p.parent ? `${p.parent}${p.sub ? ' › ' + p.sub : ''}` : null);
const historyHref = p => `#/expense?parent=${encodeURIComponent(p.parent)}`
  + (p.sub ? `&sub=${encodeURIComponent(p.sub)}` : '') + '&year=All';

/** One headed block of expiring things. */
// `mark` is an icon NAME, not the icon function — naming the parameter `icon`
// would shadow the import and print the name as text.
function section(mark, title, list, empty, add, extra = null) {
  const head = el('div', { class: 'card-head', style: 'margin:18px 0 8px' },
    el('h3', { class: 'row', style: 'gap:8px' }, icon(mark, 17), title),
    el('div', { class: 'spacer' }),
    extra,
    el('button', { class: 'btn sm', onclick: add }, '+ Add'));
  host.append(head);
  if (!list.length) {
    host.append(el('p', { class: 'small muted', style: 'margin:0 2px 4px' }, empty));
    return;
  }
  const grid = el('div', { class: 'grid g2' });
  const stop = fn => e => { e.stopPropagation(); fn(); };
  for (const p of list) {
    const badge = p.level === 'expired' ? ['⛔', 'var(--critical)', `expired ${-p.daysLeft} days ago`]
      : p.level === 'critical' ? ['🚨', 'var(--serious)', `${p.daysLeft} days left`]
      : p.level === 'soon' ? ['⚠', 'var(--warning)', `${p.daysLeft} days left`]
      : ['✓', 'var(--good)', `${p.daysLeft} days left`];
    const byPayments = p.due_mode === 'payments';
    const last = C.lastPayment(p);
    const payments = p.parent ? C.linkedPayments(p).length : 0;
    const term = C.termLabel(C.termOf(p));
    const claim = C.unclaimedPayment(p);

    const meta = el('div', { class: 'ins-meta' });
    const bit = (...k) => { if (meta.children.length) meta.append(el('span', { class: 'sep' }, '·')); meta.append(el('span', {}, ...k)); };
    if (+p.premium) bit(`Premium ${money(p.premium, p.currency || 'INR')}${term ? ` every ${term}` : ''}`);
    else if (term) bit(`Renews every ${term}`);
    if (byPayments) bit('due date follows payments');
    if (p.muted) bit('🔕 reminders off');
    else bit(`reminder ${p.notify_days || 30} days before`);

    const link = el('div', { class: 'ins-meta' });
    if (p.parent) {
      link.append(el('span', {}, linkName(p)));
      if (last) {
        link.append(el('span', { class: 'sep' }, '·'),
          el('span', {}, `last paid ${fmtDate(last.date)} · ${money(last.expense, last.currency)} · ${last.account}`));
      } else link.append(el('span', { class: 'sep' }, '·'), el('span', { class: 'muted' }, 'nothing paid under it yet'));
      if (payments) link.append(el('a', { href: historyHref(p), onclick: e => e.stopPropagation() }, `History (${payments}) →`));
    } else if (p.kind !== 'document') {
      link.append(el('span', { class: 'muted' }, 'Not linked to a category — '),
        el('a', { href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); linkScreen(); } }, 'link it'));
    }

    const acts = el('div', { class: 'ins-acts' });
    if (!byPayments && p.level !== 'ok') {
      acts.append(el('button', { class: 'btn sm primary', onclick: stop(() => renewSheet(p)) }, '↻ Renew'));
    } else if (byPayments && p.level === 'expired') {
      acts.append(el('button', { class: 'btn sm', onclick: stop(() => renewSheet(p)) }, 'Record a payment'));
    }

    grid.append(el('div', { class: 'card', style: `border-left:4px solid ${badge[1]};cursor:pointer`, onclick: () => edit(p) },
      el('div', { class: 'row' },
        el('span', { style: 'font-size:18px' }, badge[0]),
        el('div', { style: 'min-width:0' }, el('b', {}, p.label),
          el('div', { class: 'small muted' }, p.policy || '')),
        el('div', { class: 'spacer' }),
        el('div', { style: 'text-align:right' },
          el('div', { class: 'small' }, fmtDate(p.renewal_date)),
          el('div', { class: 'small muted' }, badge[2]))),
      meta,
      link.children.length ? link : null,
      p.policy_no ? el('div', { class: 'small muted mono' }, p.policy_no) : null,
      // Paid through New Transaction instead of Renew: offer to catch the date up.
      claim ? el('div', { class: 'ins-claim', onclick: e => e.stopPropagation() },
        el('span', {}, `${money(claim.expense, claim.currency)} paid on ${fmtDate(claim.date)} under this category.`),
        el('button', { class: 'btn xs primary', onclick: stop(() => renewSheet(p, { claim })) }, 'Mark renewed')) : null,
      acts.children.length ? acts : null));
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
    el('h3', { class: 'row', style: 'gap:8px' }, icon('card', 17), 'ATM Cards'),
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
  row.append(el('span', { class: 'row' }, icon('phone', 17)), body, el('div', { class: 'spacer' }), acts);

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
        toast(r.why, r.ok ? 'ok' : 'warn', 7000);
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
    el('span', { class: 'row' }, icon('bell', 17)),
    el('div', { style: 'min-width:0' }, el('b', {}, 'Renewal reminders'),
      el('div', { class: 'small muted' },
        !on ? 'Off — nothing will be announced until you switch this back on.'
          : !supported ? 'On inside the app. This browser cannot show system pop-ups.'
          : blocked ? 'On inside the app — but your browser is blocking pop-ups for this site. Allow notifications in the site settings.'
          : needsAsking ? 'On inside the app. Tap “Allow pop-ups” to get them outside it too.'
          : 'On — you get a pop-up when something falls due.')),
    el('div', { class: 'spacer' }), sw));

  card.append(el('label', { class: 'row switch-row', style: 'cursor:pointer;margin-top:8px' },
    el('span', { class: 'row' }, icon('sound', 17)),
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
        toast(head.text + ' — ' + body, 'ok', 6000);
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

// ------------------------------------------------------------ shared bits --
const nextNo = () => DB.transactions.reduce((m, x) => Math.max(m, +x.no || 0), 0) + 1;
const nowHM = () => new Date().toTimeString().slice(0, 5);

/** The account list every "Paid from" box offers — idle accounts join only when a card already names one. */
function accountOptions(keep) {
  const list = C.activeAccounts().map(a => ({ value: a.name, search: a.name, label: `${a.name} · ${a.currency}` }));
  if (keep && !list.some(o => o.value === keep)) {
    const a = DB.accounts.find(x => x.name === keep);
    if (a) list.unshift({ value: keep, search: keep, label: `${keep} · ${a.currency} (idle)` });
  }
  return list;
}
/** Expense categories, keeping the one in force even if it has since been archived. */
function categoryOptions(keep) {
  const names = C.parentsFor('Expense');
  if (keep && !names.includes(keep)) names.push(keep);
  return names.map(n => ({ value: n, search: n, label: n }));
}
function subOptions(parent, keep) {
  const names = parent ? C.subsFor('Expense', parent) : [];
  if (keep && !names.includes(keep)) names.push(keep);
  return names.map(n => ({ value: n, search: n, label: n }));
}
/** A Category box and a Sub-category box that follow each other. The sub box takes new names. */
function categoryPair(parent, sub) {
  const cat = searchSelect(categoryOptions(parent), { placeholder: 'Pick a category' });
  cat.value = parent || '';
  const subBox = searchSelect(subOptions(parent, sub), { placeholder: 'Pick or type a new one', allowNew: true });
  subBox.value = sub || '';
  cat.addEventListener('change', () => { subBox.setOptions(subOptions(cat.value, null)); subBox.value = ''; });
  return { cat, sub: subBox };
}
/** Another card already tied to this category · sub — two cards on one sub can never be told apart. */
const clashOf = (id, parent, sub) => (parent ? DB.insurance.find(x => x.id !== id && x.parent === parent
  && (x.sub || null) === (sub || null)) : null);
/** Create a sub-category typed in through "＋ Add", after asking. False when he says no. */
async function ensureSub(parent, sub) {
  if (!parent || !sub || C.subsFor('Expense', parent).includes(sub)) return true;
  if (DB.categories.some(c => c.type === 'Expense' && c.parent === parent && c.sub === sub)) return true;  // archived
  if (!(await confirmBox(`Add the sub-category “${sub}” under ${parent}?`, 'Add it'))) return false;
  await put('categories', { type: 'Expense', parent, sub, active: true });
  return true;
}

function edit(p = null, startKind = 'insurance', preset = {}) {
  const v = p || { label: '', policy: '', policy_no: '', renewal_date: addDays(todayISO(), 365),
    premium: 0, currency: 'INR', notify_days: 30, kind: startKind, note: '',
    parent: startKind === 'document' ? null : 'Insurance', sub: null, term_months: 12, due_mode: 'fixed',
    reminders_off: false, ...preset };
  const label = el('input', { value: v.label, placeholder: 'The name shown on the card — Car, Health, Iqama…' });
  const policy = el('input', { value: v.policy || '', placeholder: 'Insurer or issuing body' });
  const pno = el('input', { value: v.policy_no || '', placeholder: 'Policy / document number' });
  const date = dateBox({ value: v.renewal_date });
  const prem = el('input', { type: 'number', step: 'any', value: v.premium || 0 });
  // The premium is paid out of an account, so it is in that account's currency.
  // A free choice here silently valued a riyal premium as rupees.
  const cur = el('input', { readonly: true, tabindex: '-1', class: 'locked', value: v.currency || 'INR' });
  const days = el('input', { type: 'number', value: v.notify_days || 30 });
  const kind = el('select', {}, el('option', { value: 'insurance', selected: v.kind !== 'document' }, 'Insurance policy'),
    el('option', { value: 'document', selected: v.kind === 'document' }, 'Document (Iqama, passport, licence…)'));
  const note = el('input', { value: v.note || '' });

  // Reminders for this card alone. Off: nothing rings or pops up for it, but
  // the card itself still wears its ⚠ / ⛔ — a subscription a chitty pays, say,
  // that only needs looking at, not announcing.
  const remind = el('input', { type: 'checkbox', checked: !v.reminders_off });

  // How often it renews: years and months, either or both — or no fixed term,
  // for a paper renewed whenever the office says (the date is asked each time).
  const t0 = C.termOf(v);
  const years = el('input', { type: 'number', min: 0, max: 50, step: 1, value: t0 ? Math.floor(t0 / 12) : 1 });
  const months = el('input', { type: 'number', min: 0, max: 120, step: 1, value: t0 ? t0 % 12 : 0 });
  const noTerm = el('input', { type: 'checkbox', checked: t0 === 0 });
  const paintTerm = () => { years.disabled = months.disabled = noTerm.checked; };
  noTerm.addEventListener('change', paintTerm); paintTerm();
  const termMonths = () => (noTerm.checked ? 0 : Math.max(0, Math.round(+years.value || 0)) * 12 + Math.max(0, Math.round(+months.value || 0)));

  // Option text stays short: a phone-width select cuts a long one off mid-word.
  // The longer explanation sits under it and changes with the choice.
  const mode = el('select', {},
    el('option', { value: 'fixed', selected: v.due_mode !== 'payments' }, 'Fixed date — Renew moves it'),
    el('option', { value: 'payments', selected: v.due_mode === 'payments' }, 'Follows the payments'));
  const modeHint = el('div', { class: 'hint' });
  const paintMode = () => { modeHint.textContent = mode.value === 'payments'
    ? 'Due one term after the last entry in its sub-category — for a scheme someone else pays (a chitty, say).'
    : 'Due on the date above. Renew moves it on by the term.'; };
  mode.addEventListener('change', paintMode); paintMode();

  // Renewing is a payment. It should leave an account, like every other payment.
  // With none saved yet, the account the last premium actually came from — not
  // simply the first cash account, which put a rupee policy on a riyal wallet.
  const lastPaid = C.lastPayment(v);
  const payFrom = searchSelect(accountOptions(v.pay_account || lastPaid?.account), { placeholder: 'Pick an account' });
  payFrom.value = v.pay_account || lastPaid?.account || '';
  const followAccount = () => { cur.value = C.currencyOf(payFrom.value) || cur.value; };
  payFrom.addEventListener('change', followAccount);
  followAccount();

  // Where its premiums are filed. One card per sub-category, so its payments
  // can always be told apart from every other card's.
  const link = categoryPair(v.parent, v.sub);
  kind.addEventListener('change', () => {
    if (kind.value !== 'document' && !link.cat.value) {
      link.cat.value = 'Insurance'; link.sub.setOptions(subOptions('Insurance', null)); link.sub.value = '';
    }
  });

  // ---------------------------------------------------------- attachments --
  // The invoice and the warranty card for a machine, so a service desk can be
  // shown them here rather than after a trip home to the drawer.
  // The id is settled now rather than at save time, because the file path
  // carries it and a file cannot wait for the record to be written.
  const recId = v.id || uuid();
  let files = Array.isArray(v.files) ? [...v.files] : [];
  const fileList = el('div', { style: 'margin-top:6px' });
  const picker = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, style: 'display:none' });
  const busy = el('span', { class: 'small muted' });
  const addBtn = el('button', { type: 'button', class: 'btn sm', onclick: () => picker.click() }, '📎 Attach');

  async function openFile(f) {
    // The tab is opened BEFORE the await. Asking for the link first and opening
    // afterwards is a pop-up blocker's definition of suspicious.
    const w = window.open('', '_blank');
    const r = await F.link(f.path);
    if (!r.ok) { w?.close(); return toast(r.why, 'warn', 4500); }
    if (w) { w.opener = null; w.location = r.url; } else window.location.href = r.url;
  }

  async function dropFile(f) {
    if (!await confirmBox(`Remove “${f.name}”?`)) return;
    const r = await F.remove(f.path);
    if (!r.ok) return toast(r.why, 'warn', 4500);
    files = files.filter(x => x.path !== f.path);
    paintFiles();
    toast('Removed — press Save to keep the change');
  }

  function paintFiles() {
    fileList.replaceChildren();
    if (!files.length) {
      fileList.append(el('p', { class: 'hint', style: 'margin:0' },
        'Invoices, warranty cards, receipts. Photos or PDF, up to '
        + `${F.prettySize(F.MAX_BYTES)} each. Kept private — opening one makes a link that dies after an hour.`));
      return;
    }
    for (const f of files) {
      fileList.append(el('div', { class: 'file-row' },
        el('span', { class: 'row' }, icon('doc', 16)),
        el('span', { class: 'file-name' }, f.name),
        el('span', { class: 'small muted' }, F.prettySize(f.size || 0)),
        el('button', { type: 'button', class: 'btn xs', onclick: () => openFile(f) }, 'Open'),
        el('button', { type: 'button', class: 'btn xs ghost', onclick: () => dropFile(f) }, 'Remove')));
    }
  }

  picker.addEventListener('change', async () => {
    const picked = [...picker.files];
    picker.value = '';                       // so the same file can be picked again
    addBtn.disabled = true;
    for (const file of picked) {
      busy.textContent = `Uploading ${file.name}…`;
      const r = await F.upload(file, recId);
      if (!r.ok) { toast(r.why, 'warn', 5000); continue; }
      files.push(r.file);
      paintFiles();
    }
    busy.textContent = '';
    addBtn.disabled = false;
  });
  paintFiles();

  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const body = el('div', { class: 'form-grid' },
    fld('Short label (shown on the card)', label, 'full'), fld('Type', kind, 'full'),
    fld('Provider / policy', policy, 'full'),
    fld('Policy / document no.', pno, 'full'),
    fld('Renews / expires on', date), fld('Remind me days before', days),
    el('label', { class: 'field full inline-check' }, remind,
      el('span', {}, 'Remind me about this one',
        el('span', { class: 'sub' }, 'Off: no bell, pop-up or push. The card still shows ⚠ / ⛔.'))),
    fld('Renews every', el('div', { class: 'term-row' },
      years, el('span', {}, 'years'), months, el('span', {}, 'months'),
      el('label', { class: 'inline-check', style: 'flex-basis:100%' }, noTerm, el('span', {}, 'No fixed term — I set the date each time'))), 'full'),
    el('div', { class: 'field full' }, el('label', {}, 'Due date'), mode, modeHint),
    fld('Premium', prem), fld('Currency', cur),
    fld('Pay from', payFrom, 'full'),
    fld('Expense category', link.cat), fld('Sub-category', link.sub),
    fld('Note', note, 'full'),
    el('div', { class: 'field full' }, el('label', {}, 'Attachments'),
      el('div', { class: 'row gap wrap', style: 'align-items:center' }, addBtn, busy, picker),
      fileList));

  /** Check and write the card as it stands in the sheet. Returns the saved row, or null. */
  async function saveCard() {
    if (!label.value.trim()) { toast('Give it a label', 'warn'); label.focus(); return null; }
    // The renewal date is the whole reason this row exists — filed as year 2
    // it expires two thousand years ago and the reminder never comes.
    if (badYear(date.value) || !date.value) { toast('Finish the renewal date', 'warn'); date.focus(); return null; }
    const parent = link.cat.value || null, sub = link.sub.value || null;
    const term = termMonths();
    if (mode.value === 'payments' && (!parent || !term)) {
      toast('“Follows the payments” needs a category and a term (e.g. 1 month)', 'warn', 5000); return null;
    }
    // A policy is tied to its own sub-category, never to the whole of
    // Insurance — the premiums of every card would land in one heap.
    if (parent && !sub && kind.value !== 'document') {
      toast('Pick this policy’s own sub-category, or type a new one', 'warn', 5000); return null;
    }
    const clash = clashOf(recId, parent, sub);
    if (clash) {
      toast(`“${clash.label}” already uses ${parent}${sub ? ' › ' + sub : ''}. Give this one its own sub-category.`, 'warn', 6000);
      return null;
    }
    if (!(await ensureSub(parent, sub))) return null;
    return put('insurance', { ...v, id: recId, label: label.value.trim(), policy: policy.value.trim(),
      policy_no: pno.value.trim(), renewal_date: date.value, premium: +prem.value || 0,
      currency: cur.value, notify_days: +days.value || 30, kind: kind.value,
      note: note.value.trim(), files,
      // Saved now: Pay from used to feed only Renew and was thrown away on Save.
      pay_account: payFrom.value || null,
      parent, sub, term_months: term, due_mode: mode.value, reminders_off: !remind.checked });
  }

  // An Iqama is not a policy. The section you pressed Add in already says which
  // of the two this is, so the sheet should say it back to you.
  const noun = v.kind === 'document' ? 'document' : 'policy';
  const m = modal(`${p ? 'Edit' : 'New'} ${noun}`, body, {
    footer: [
      p ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox(`Remove this ${noun}?`)) { await remove('insurance', p.id); m.close(); } } }, 'Delete') : null,
      // Renew works on the card as it stands here, so it saves first.
      p ? el('button', { class: 'btn', title: 'Saves this card, then renews it', onclick: async () => {
        const saved = await saveCard();
        if (!saved) return;
        m.close();
        renewSheet(saved);
      } }, v.due_mode === 'payments' ? 'Record a payment' : '↻ Renew') : null,
      el('button', { class: 'btn primary', onclick: async () => { if (await saveCard()) m.close(); } }, 'Save'),
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------------ renew --
/**
 * Renewing is two things that belong together: the card moves to its next
 * date, and the premium goes into the ledger under the card's category — as
 * an ordinary Expense entry he can open and change later like any other.
 *
 * Nothing is written until he presses the button. Either both land or neither
 * does, and the toast offers Undo for the pair.
 *
 * `claim` — a payment already filed under the category (entered through New
 * Transaction): the card only has to catch its date up, so nothing new is
 * recorded.
 */
async function renewSheet(p, { claim = null } = {}) {
  const card = DB.insurance.find(x => x.id === p.id) || p;
  const byPayments = card.due_mode === 'payments';
  const term = C.termOf(card);
  const today = todayISO();

  // Pressed twice by mistake is two years and two premiums. Ask.
  if (!byPayments && !claim && card.last_paid) {
    const ago = daysBetween(String(card.last_paid).slice(0, 10), today);
    if (ago >= 0 && ago < 30 && !(await confirmBox(
      `${card.label} was already renewed on ${fmtDate(card.last_paid)}. Renew it again?`, 'Renew again'))) return;
  }

  const oldDue = String(card.renewal_date || '').slice(0, 10);
  // One term on from the old date. A card that lapsed long ago starts again from today.
  const onFrom = n => { if (!n) return ''; let d = C.addTerm(oldDue || today, n); if (d <= today) d = C.addTerm(today, n); return d; };
  const last = C.lastPayment(card);

  const newDate = dateBox({ value: onFrom(term) });
  const chips = el('div', { class: 'chips-row' },
    ...[[3, '+3 months'], [6, '+6 months'], [12, '+1 year'], [24, '+2 years'], [36, '+3 years'], [60, '+5 years'], [120, '+10 years']]
      .map(([n, t]) => el('button', { type: 'button', class: 'chip' + (n === term ? ' on' : ''), tabindex: '-1',
        onclick: e => {
          newDate.value = onFrom(n); newDate.dispatchEvent(new Event('change'));
          [...chips.children].forEach(c => c.classList.toggle('on', c === e.currentTarget));
        } }, t)));
  // A date typed by hand is no longer any of the chips.
  newDate.addEventListener('input', () => [...chips.children].forEach(c => c.classList.remove('on')));

  const record = el('input', { type: 'checkbox', checked: !claim && (!!card.parent || +card.premium > 0) });
  const startAcct = card.pay_account || last?.account || C.cashAccounts()[0]?.name || '';
  const acct = searchSelect(accountOptions(startAcct), { placeholder: 'Pick an account' });
  acct.value = startAcct;
  let acctCur = C.currencyOf(acct.value) || card.currency || 'INR';
  // The card's premium is in the card's currency, the last payment in its own;
  // either is re-stated in the currency of the account paying now.
  const inAcct = (amt, cur) => (!amt ? 0 : (cur || acctCur) === acctCur ? amt : C.convertAmount(amt, cur, acctCur, today));
  const startAmt = +card.premium ? inAcct(+card.premium, card.currency) : last ? inAcct(+last.expense, last.currency) : 0;
  const amount = el('input', { type: 'number', step: 'any', value: startAmt ? round2(startAmt) : '', style: 'flex:1;min-width:0' });
  const curTag = el('span', { class: 'small muted' }, acctCur);
  const paidOn = dateBox({ value: today });
  const link = categoryPair(card.parent || (card.kind !== 'document' ? 'Insurance' : null), card.sub);
  const noteIn = el('input', {});
  const asPremium = el('input', { type: 'checkbox', checked: true });
  const asPremiumRow = el('label', { class: 'field full inline-check' },
    asPremium, el('span', {}, 'Also make this the premium on the card'));
  const convHint = el('div', { class: 'hint' });

  // The line writes itself from the new date, in the words he already uses —
  // "Star Health renewed upto 03-10-2027" — until he types his own.
  let autoNote = '';
  const writeNote = () => {
    if (noteIn.value.trim() && noteIn.value !== autoNote) return;
    autoNote = byPayments ? `${card.label} payment`
      : `${card.label}${card.policy ? ' (' + card.policy + ')' : ''} renewed upto ${fmtDate(newDate.value)}`;
    noteIn.value = autoNote;
  };
  newDate.addEventListener('change', writeNote);
  newDate.addEventListener('input', writeNote);
  writeNote();

  const paintPremium = () => { asPremiumRow.hidden = !record.checked || round2(+amount.value || 0) === round2(+card.premium || 0) && acctCur === (card.currency || acctCur); };
  amount.addEventListener('input', paintPremium);

  // Paying from an account in another currency: the amount is re-stated in
  // that currency at the day's rate, and says so. He can still type the figure
  // the bank actually took.
  acct.addEventListener('change', () => {
    const next = C.currencyOf(acct.value) || acctCur;
    if (next !== acctCur && +amount.value) {
      const was = +amount.value;
      amount.value = round2(C.convertAmount(was, acctCur, next, paidOn.value || today));
      convHint.textContent = `${money(was, acctCur)} is about ${money(+amount.value, next)} at the rate for ${String(paidOn.value || today).slice(0, 7)} — change it if the bank took something else.`;
    } else convHint.textContent = '';
    acctCur = next; curTag.textContent = acctCur; paintPremium();
  });

  const fld = (l, n, cls = '') => el('div', { class: 'field ' + cls }, el('label', {}, l), n);
  const entry = el('div', { class: 'form-grid full', style: 'grid-column:1/-1' },
    fld('Amount', el('div', { class: 'row', style: 'gap:6px' }, amount, curTag), ''), fld('Paid on', paidOn),
    el('div', { class: 'full' }, convHint),
    fld('Paid from', acct, 'full'),
    fld('Expense category', link.cat), fld('Sub-category', link.sub),
    fld('Description', noteIn, 'full'),
    asPremiumRow);
  const paintEntry = () => { entry.hidden = !record.checked; paintPremium(); };
  record.addEventListener('change', paintEntry);

  const body = el('div', { class: 'form-grid' },
    byPayments ? el('p', { class: 'hint full', style: 'margin:0' },
      `The date on this card follows its payments: one ${C.termLabel(term) || 'term'} after the last one filed under it.`) : null,
    byPayments ? null : fld(term ? `New date (was ${fmtDate(oldDue)})` : 'New date — this card has no fixed term', newDate, 'full'),
    byPayments ? null : el('div', { class: 'full' }, chips),
    claim ? el('p', { class: 'hint full', style: 'margin:0' },
      `${money(claim.expense, claim.currency)} was paid on ${fmtDate(claim.date)} from ${claim.account}. It is already in the ledger, so nothing new is recorded.`) : null,
    claim ? null : el('label', { class: 'field full inline-check' },
      record, el('span', {}, byPayments ? 'Record this payment as a transaction' : 'Record the premium as a transaction')),
    claim ? null : entry);
  paintEntry();

  const m = modal(byPayments ? `Record a payment — ${card.label}` : `Renew ${card.label}`, body, {
    footer: [el('button', { class: 'btn primary', onclick: () => go() }, byPayments ? 'Record it' : 'Renew')],
  });

  async function go() {
    const want = byPayments ? null : newDate.value;
    if (!byPayments) {
      if (!want || badYear(want)) { toast('Set the new date', 'warn'); newDate.focus(); return; }
    }
    const doRecord = !claim && record.checked;
    if (byPayments && !doRecord) { toast('Nothing to record', 'warn'); return; }
    let parent = card.parent || null, sub = card.sub || null, amt = 0;
    if (doRecord) {
      amt = round2(+amount.value || 0);
      if (!(amt > 0)) { toast('Enter the amount paid', 'warn'); amount.focus(); return; }
      if (!acct.value) { toast('Pick the account it was paid from', 'warn'); return; }
      if (!paidOn.value || badYear(paidOn.value)) { toast('Check the date it was paid', 'warn'); paidOn.focus(); return; }
      parent = link.cat.value || null; sub = link.sub.value || null;
      if (!parent) { toast('Pick the Expense category it goes under', 'warn'); return; }
      const clash = clashOf(card.id, parent, sub);
      if (clash) { toast(`“${clash.label}” already uses ${parent}${sub ? ' › ' + sub : ''}. Pick this card's own sub-category.`, 'warn', 6000); return; }
      if (!(await ensureSub(parent, sub))) return;
    }

    const before = { ...card };
    let tx = null;
    try {
      if (doRecord) {
        tx = await put('transactions', {
          id: uuid(), no: nextNo(), date: paidOn.value, time: nowHM(), type: 'Expense',
          account: acct.value, currency: acctCur, income: 0, expense: amt,
          parent, sub, payee: null, event: null, note: noteIn.value.trim() || null,
          fx: C.fxFor(paidOn.value), transfer_group: null, to_account: null,
        });
      }
      const paid = claim ? claim.date : doRecord ? paidOn.value : today;
      await put('insurance', {
        ...card,
        renewal_date: byPayments ? card.renewal_date : want,
        last_paid: paid,
        pay_account: doRecord ? acct.value : card.pay_account,
        parent, sub,
        ...(doRecord && asPremium.checked && !asPremiumRow.hidden ? { premium: amt, currency: acctCur } : {}),
      });
    } catch (e) {
      // Both or neither: a premium in the ledger for a card that did not move
      // (or the other way round) is exactly the mismatch this is here to end.
      if (tx) await remove('transactions', tx.id).catch(() => {});
      console.error('[renew]', e);
      return toast('Could not save: ' + (e?.message || e), 'warn', 6000);
    }
    m.close();
    const said = byPayments ? `${card.label}: ${money(amt, acctCur)} recorded`
      : `${card.label} renewed to ${fmtDate(want)}${tx ? ` · ${money(amt, acctCur)} recorded` : ''}`;
    toast(said, 'ok', 8000, { label: 'Undo', run: async () => {
      if (tx) await remove('transactions', tx.id);
      await put('insurance', before);
      toast('Undone');
    } });
  }
}

// ------------------------------------------------------------------- links --
/** Words worth matching on: "Shield Accident Cover" → shield, accident, cover. */
const STOP = new Set(['insurance', 'policy', 'premium', 'renewal', 'renewed', 'the', 'and', 'for', 'card',
  'cover', 'coverage', 'plan', 'upto', 'till', 'until', 'valid', 'paid', 'money', 'with', 'from']);
const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9ഀ-ൿ]+/g, ' ').split(' ')
  .filter(w => w.length >= 3 && !STOP.has(w));
const matches = (words, toks) => toks.some(t => words.some(w => w === t || (t.length >= 4 && w.startsWith(t))));

/**
 * Tie every policy to its Expense sub-category, once. Each gets a suggestion —
 * from its name and provider against the sub-category names, and against the
 * descriptions of the entries already filed — which he can take or change.
 * Premium and Pay from can be filled from the last payment. Entries that
 * plainly belong to one card but sit in another card's sub-category (a
 * "Shield" premium filed under "Accident Cover") are offered for moving, one
 * tick each.
 */
function linkScreen() {
  const PARENT = 'Insurance';
  const cards = DB.insurance.filter(p => p.kind !== 'document')
    .sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || a.label.localeCompare(b.label));
  if (!cards.length) return toast('No policies yet — add one first', 'warn');
  const subsNow = () => C.subsFor('Expense', PARENT);
  const entriesOf = sub => DB.transactions.filter(t => t.type === 'Expense' && t.parent === PARENT && (t.sub || null) === (sub || null));
  const cardToks = c => tokens(`${c.label} ${c.policy || ''}`);

  // ---- suggestions: best score first, one sub per card, one card per sub ----
  const pick = new Map(cards.filter(c => c.parent === PARENT && c.sub).map(c => [c.id, c.sub]));
  const taken = new Set([...pick.values(), ...DB.insurance.filter(x => x.kind === 'document' && x.parent === PARENT && x.sub).map(x => x.sub)]);
  const pairs = [];
  for (const c of cards) {
    if (pick.has(c.id)) continue;
    const toks = cardToks(c);
    for (const s of subsNow()) {
      const nameHits = toks.filter(t => tokens(s).some(w => w === t || (t.length >= 4 && w.startsWith(t)))).length;
      const noteHits = entriesOf(s).filter(t => matches(tokens(t.note), toks)).length;
      const score = nameHits * 10 + noteHits;
      if (score > 0) pairs.push({ id: c.id, sub: s, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const q of pairs) if (!pick.has(q.id) && !taken.has(q.sub)) { pick.set(q.id, q.sub); taken.add(q.sub); }

  // ---- one row per policy ----
  const rows = cards.map(c => {
    const box = searchSelect(subOptions(PARENT, pick.get(c.id)), { placeholder: 'Pick or type a new one', allowNew: true });
    box.value = pick.get(c.id) || '';
    const info = el('div', { class: 'small muted' });
    const fill = el('input', { type: 'checkbox' });
    const fillRow = el('label', { class: 'small inline-check' }, fill, el('span', {}, 'Use the last payment for Premium and Pay from'));
    const moves = el('div', { class: 'link-moves' });
    const row = { card: c, box, fill, moveTicks: [], fillTouched: false };
    fill.addEventListener('change', () => { row.fillTouched = true; });
    // What the card will have under it once saved — including entries he has
    // ticked to move in, so Shield's one premium can fill Shield's card.
    row.paint = () => {
      const s = box.value || null;
      const leaving = new Set(rows.flatMap(r => r.moveTicks.filter(m => m.tick.checked).map(m => m.t.id)));
      const list = s ? [...entriesOf(s).filter(t => !leaving.has(t.id)), ...row.moveTicks.filter(m => m.tick.checked).map(m => m.t)] : [];
      const last = list.sort((a, b) => b.date.localeCompare(a.date))[0];
      info.textContent = !s ? 'Not linked'
        : !list.length ? 'Nothing filed under it yet'
        : `${list.length} ${list.length === 1 ? 'entry' : 'entries'} · last ${fmtDate(last.date)} · ${money(last.expense, last.currency)} · ${last.account}`;
      fillRow.hidden = !last;
      if (!row.fillTouched) fill.checked = !!last && !(+c.premium);
      row.last = last;
    };
    box.addEventListener('change', () => { row.moveTicks = []; paintMoves(); rows.forEach(r => r.paint()); });
    row.el = el('div', { class: 'link-row' },
      el('div', { class: 'row' }, el('b', {}, c.label), el('span', { class: 'small muted', style: 'margin-left:8px' }, c.policy || '')),
      el('div', { class: 'field', style: 'margin:0' }, el('label', {}, `${PARENT} › sub-category`), box),
      info, fillRow, moves);
    row.moves = moves;
    return row;
  });

  // Entries that name one card but sit under another card's sub-category.
  function paintMoves() {
    const bySub = new Map(rows.filter(r => r.box.value).map(r => [r.box.value, r]));
    for (const r of rows) {
      r.moves.replaceChildren(); r.moveTicks = [];
      const s = r.box.value;
      if (!s) continue;
      const mine = cardToks(r.card);
      const found = DB.transactions.filter(t => t.type === 'Expense' && t.parent === PARENT && t.sub !== s
        && matches(tokens(t.note), mine)
        // …unless the card that owns that sub is named in it too: an HDFC
        // "life and health" entry stays with the HDFC card, not with Health.
        && !(bySub.get(t.sub) && matches(tokens(t.note), cardToks(bySub.get(t.sub).card))));
      if (!found.length) continue;
      r.moves.append(el('div', { class: 'small' }, el('b', {}, `Move into “${s}”?`),
        ' These mention this card but are filed elsewhere. Tick the ones that belong here.'));
      for (const t of found.sort((a, b) => b.date.localeCompare(a.date))) {
        const tick = el('input', { type: 'checkbox' });
        tick.addEventListener('change', () => rows.forEach(x => x.paint()));
        r.moveTicks.push({ tick, t });
        r.moves.append(el('label', {}, tick,
          el('span', {}, `${fmtDate(t.date)} · ${money(t.expense, t.currency)} · now under “${t.sub || '—'}” — ${t.note || ''}`)));
      }
    }
  }
  paintMoves();
  rows.forEach(r => r.paint());

  // Sub-categories with entries but no card — a small cover, a welfare fund someone else pays.
  const loose = el('div', {});
  const paintLoose = () => {
    const used = new Set([...rows.map(r => r.box.value).filter(Boolean),
      ...DB.insurance.filter(x => x.parent === PARENT && x.sub).map(x => x.sub)]);
    const free = subsNow().filter(s => !used.has(s) && entriesOf(s).length);
    loose.replaceChildren();
    if (!free.length) return;
    loose.append(el('h4', { style: 'margin:14px 0 6px' }, 'Sub-categories with payments but no card'));
    for (const s of free) {
      const list = entriesOf(s).sort((a, b) => b.date.localeCompare(a.date));
      loose.append(el('div', { class: 'row', style: 'gap:8px;padding:4px 0' },
        el('span', { style: 'flex:1' }, s, el('span', { class: 'small muted' },
          ` · ${list.length} entries · last ${fmtDate(list[0].date)} · ${money(list[0].expense, list[0].currency)}`)),
        el('button', { class: 'btn xs', onclick: () => closeThen(m, () => edit(null, 'insurance', {
          label: s, parent: PARENT, sub: s, premium: +list[0].expense, currency: list[0].currency,
          pay_account: list[0].account, renewal_date: C.addTerm(list[0].date, 12), last_paid: list[0].date,
        })) }, '＋ Make a card')));
    }
  };
  for (const r of rows) r.box.addEventListener('change', paintLoose);
  paintLoose();

  const body = el('div', {},
    el('p', { class: 'hint', style: 'margin:0 0 6px' },
      'Each policy gets its own sub-category under Insurance. Renew files the premium there, and the card shows what was paid. '
      + 'The name on the card stays as you set it.'),
    ...rows.map(r => r.el), loose);

  const m = modal('Link policies', body, {
    wide: true,
    footer: [el('button', { class: 'btn primary', onclick: () => save() }, 'Save links')],
  });

  async function save() {
    const seen = new Map();
    for (const r of rows) {
      const s = r.box.value;
      if (!s) continue;
      if (seen.has(s)) return toast(`“${seen.get(s)}” and “${r.card.label}” both picked “${s}”. One sub-category per card.`, 'warn', 6000);
      const other = DB.insurance.find(x => !rows.some(y => y.card.id === x.id) && x.parent === PARENT && x.sub === s);
      if (other) return toast(`“${other.label}” already uses “${s}”.`, 'warn', 6000);
      seen.set(s, r.card.label);
    }
    for (const r of rows) if (r.box.value && !(await ensureSub(PARENT, r.box.value))) return;

    const cardRows = [], moved = [];
    for (const r of rows) {
      const s = r.box.value || null;
      const c = DB.insurance.find(x => x.id === r.card.id) || r.card;
      const next = { ...c, parent: s ? PARENT : (c.parent === PARENT ? null : c.parent), sub: s || (c.parent === PARENT ? null : c.sub) };
      if (s && r.fill.checked && r.last) {
        Object.assign(next, { premium: +r.last.expense, currency: r.last.currency, pay_account: r.last.account,
          // The payment already made is this period's, so the card must not
          // offer to "mark renewed" for it.
          last_paid: c.last_paid && String(c.last_paid) > r.last.date ? c.last_paid : r.last.date });
      }
      if (next.parent !== c.parent || next.sub !== c.sub || next.premium !== c.premium || next.pay_account !== c.pay_account || next.last_paid !== c.last_paid) cardRows.push(next);
      for (const { tick, t } of r.moveTicks) if (tick.checked && s) moved.push({ ...t, sub: s });
    }
    if (moved.length) await putMany('transactions', moved);
    if (cardRows.length) await putMany('insurance', cardRows);
    m.close();
    toast(`${cardRows.length} ${cardRows.length === 1 ? 'card' : 'cards'} linked${moved.length ? ` · ${moved.length} ${moved.length === 1 ? 'entry' : 'entries'} moved` : ''}`, 'ok', 5000);
  }
}

function exportCSV() {
  downloadCSV(`jinnyfin-policies-${todayISO()}.csv`,
    [['Label', 'Type', 'Provider', 'Number', 'Renewal date', 'Days left', 'Premium', 'Currency', 'Renews every',
      'Due date', 'Reminders', 'Category', 'Sub-category', 'Last paid', 'Last amount', 'Paid from'],
      ...C.insuranceAlerts().map(p => {
        const last = C.lastPayment(p);
        return [p.label, p.kind, p.policy || '', p.policy_no || '', p.renewal_date, p.daysLeft, p.premium || 0, p.currency || 'INR',
          C.termLabel(C.termOf(p)) || 'no fixed term', p.due_mode === 'payments' ? 'follows payments' : 'fixed',
          p.muted ? 'off' : 'on', p.parent || '', p.sub || '', last?.date || '', last ? last.expense : '', last?.account || ''];
      })]);
}
