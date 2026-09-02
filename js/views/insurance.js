// ============================================================================
//  insurance.js — policies and documents that expire, with reminders.
// ============================================================================
import { el, money, fmtDate, todayISO, modal, toast, confirmBox, addDays, downloadCSV } from '../util.js';
import { DB, put, remove, getSettings, setSettings } from '../store.js';
import * as C from '../calc.js';
import { topbar } from '../app.js';
import { kpi } from './report.js';

let host = null;

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  host.innerHTML = '';
  const rows = C.insuranceAlerts();
  const head = C.insuranceHeadline();
  host.append(topbar('Insurance & Documents',
    el('button', { class: 'btn sm', onclick: () => edit() }, '+ Policy'),
    el('button', { class: 'btn sm', onclick: exportCSV }, '⬇ CSV')));

  host.append(el('div', { class: 'alert ' + head.level },
    el('span', { class: 'ico' }, head.level === 'ok' ? '✓' : head.level === 'expired' ? '⛔' : '⚠'),
    el('div', {}, el('b', {}, head.text),
      head.then ? el('div', { class: 'small muted' }, `then ${head.then.label} in ${head.then.daysLeft} days`) : null)));

  host.append(notifyCard());

  const expired = rows.filter(r => r.level === 'expired').length;
  const soon = rows.filter(r => r.level === 'soon' || r.level === 'critical').length;
  host.append(el('div', { class: 'grid g4 keep2', style: 'margin-top:12px' },
    kpi('Policies tracked', String(rows.length)),
    kpi('Expiring within 30 days', String(soon), soon ? 'expense' : ''),
    kpi('Already expired', String(expired), expired ? 'expense' : ''),
    kpi('Annual premium', money(rows.reduce((s, r) => s + (r.currency === 'SAR' ? (+r.premium || 0) * C.rates().sar : +r.premium || 0), 0), 'INR', false))));

  const list = el('div', { class: 'grid g2', style: 'margin-top:12px' });
  for (const p of rows) {
    const badge = p.level === 'expired' ? ['⛔', 'var(--critical)', `expired ${-p.daysLeft} days ago`]
      : p.level === 'critical' ? ['🚨', 'var(--serious)', `${p.daysLeft} days left`]
      : p.level === 'soon' ? ['⚠', 'var(--warning)', `${p.daysLeft} days left`]
      : ['✓', 'var(--good)', `${p.daysLeft} days left`];
    list.append(el('div', { class: 'card', style: `border-left:4px solid ${badge[1]};cursor:pointer`, onclick: () => edit(p) },
      el('div', { class: 'row' },
        el('span', { style: 'font-size:18px' }, badge[0]),
        el('div', {}, el('b', {}, p.label), el('div', { class: 'small muted' }, p.policy || '')),
        el('div', { class: 'spacer' }),
        el('div', { style: 'text-align:right' },
          el('div', { class: 'small' }, fmtDate(p.renewal_date)),
          el('div', { class: 'small muted' }, badge[2]))),
      p.premium ? el('div', { class: 'small muted', style: 'margin-top:6px' },
        `Premium ${money(p.premium, p.currency || 'INR')} · reminder ${p.notify_days || 30} days before`) : null,
      p.policy_no ? el('div', { class: 'small muted mono' }, p.policy_no) : null));
  }
  host.append(list);
  if (!rows.length) host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🛡️'),
    el('p', {}, 'No policies yet.'), el('button', { class: 'btn primary', onclick: () => edit() }, 'Add the first one')));
}

// -------------------------------------------------------- notifications ---
function notifyCard() {
  const s = getSettings();
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const card = el('div', { class: 'card tight' });
  const row = el('div', { class: 'row' },
    el('span', {}, '🔔'),
    el('div', {}, el('b', {}, 'Renewal reminders'),
      el('div', { class: 'small muted' },
        perm === 'granted' ? 'On — this device pops a reminder when something is close to expiry.'
          : perm === 'denied' ? 'Blocked in your browser settings. Allow notifications for this site to switch it on.'
          : !supported ? 'This browser cannot show notifications.'
          : 'Off — turn it on to get a pop-up even when the app is closed.')),
    el('div', { class: 'spacer' }));
  if (supported && perm !== 'granted') {
    row.append(el('button', {
      class: 'btn sm primary', onclick: async () => {
        const r = await Notification.requestPermission();
        if (r === 'granted') { toast('Reminders on'); setSettings({ notify: true }); draw(); }
        else toast('Not allowed', 'warn');
      },
    }, 'Turn on'));
  } else if (perm === 'granted') {
    row.append(el('button', {
      class: 'btn sm', onclick: async () => {
        const reg = await navigator.serviceWorker?.getRegistration();
        const head = C.insuranceHeadline();
        const opts = { body: head.next ? `${head.next.label} renews ${fmtDate(head.next.renewal_date)}` : 'Nothing due soon.', icon: 'icons/icon-192.png' };
        if (reg) reg.showNotification('Jinnyfin · ' + head.text, opts); else new Notification('Jinnyfin · ' + head.text, opts);
      },
    }, 'Test'));
  }
  card.append(row);
  card.append(el('p', { class: 'hint', style: 'margin:8px 0 0' },
    'Want an e-mail too? The repo ships a GitHub Action ('
    , el('span', { class: 'mono' }, '.github/workflows/expiry-email.yml')
    , ') that checks every morning and mails you — see SETUP.md.'));
  return card;
}

/**
 * Push the renewal date on a year and, unless told not to, put the premium
 * through the books: an expense on the account that paid it, so it shows up in
 * that account's statement and in Transactions like any other payment.
 */
async function renew(v, m, o) {
  if (o.record && o.premium > 0 && !o.account) return toast('Which account paid it?', 'warn');
  const paid = printableDate();
  if (!(await confirmBox(
    (o.record && o.premium > 0
      ? `Renew ${o.label} for a year and record ${money(o.premium, o.currency)} paid from ${o.account}?`
      : `Renew ${o.label} for another year? No payment will be recorded.`), 'Renew'))) return;

  await put('insurance', { ...v, renewal_date: addDays(v.renewal_date, 365),
    premium: o.premium, currency: o.currency, pay_account: o.account, last_paid: paid });

  if (o.record && o.premium > 0) {
    const fx = C.fxFor(paid);
    const seq = Math.max(0, ...DB.transactions.map(t => t.no || 0)) + 1;
    await put('transactions', {
      no: seq, date: paid, time: new Date().toTimeString().slice(0, 5),
      type: 'Expense', account: o.account, currency: o.currency,
      income: 0, expense: o.premium, fx,
      parent: 'Insurance', sub: o.label,
      payee: v.policy || null, event: null,
      note: `${o.label} renewed — premium for ${addDays(v.renewal_date, 365).slice(0, 4)}`,
    });
    toast(`Renewed, and ${money(o.premium, o.currency)} recorded on ${o.account}`, 'ok', 5000);
  } else {
    toast('Renewed for another year');
  }
  m.close();
}

const printableDate = () => todayISO();

function edit(p = null) {
  const v = p || { label: '', policy: '', policy_no: '', renewal_date: addDays(todayISO(), 365),
    premium: 0, currency: 'INR', notify_days: 30, kind: 'insurance', note: '' };
  const label = el('input', { value: v.label, placeholder: 'Car / Health / Iqama / Passport' });
  const policy = el('input', { value: v.policy || '', placeholder: 'Insurer or issuing body' });
  const pno = el('input', { value: v.policy_no || '', placeholder: 'Policy / document number' });
  const date = el('input', { type: 'date', value: v.renewal_date });
  const prem = el('input', { type: 'number', step: 'any', value: v.premium || 0 });
  const cur = el('select', {}, ...['INR', 'SAR', 'USD'].map(c => el('option', { value: c, selected: v.currency === c }, c)));
  const days = el('input', { type: 'number', value: v.notify_days || 30 });
  const kind = el('select', {}, el('option', { value: 'insurance', selected: v.kind !== 'document' }, 'Insurance policy'),
    el('option', { value: 'document', selected: v.kind === 'document' }, 'Document (Iqama, passport, licence…)'));
  const note = el('input', { value: v.note || '' });
  // Renewing is a payment. It should leave an account, like every other payment.
  const payFrom = el('select', {}, ...C.activeAccounts()
    .map(a => el('option', { value: a.name, selected: v.pay_account === a.name }, `${a.name} · ${a.currency}`)));
  if (!v.pay_account) payFrom.value = C.cashAccounts()[0]?.name || payFrom.value;
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
