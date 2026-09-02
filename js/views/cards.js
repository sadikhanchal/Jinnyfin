// ============================================================================
//  cards.js — the encrypted card vault.
//
//  What is stored in the cloud in readable form: a label, the bank, the network
//  and the last four digits. Everything else — full number, expiry, CVV, ATM PIN,
//  notes — is AES-256-GCM ciphertext that only your vault PIN can open.
// ============================================================================
import { el, modal, toast, confirmBox, fmtDate, todayISO, daysBetween } from '../util.js';
import { DB, put, remove } from '../store.js';
import { encryptJSON, decryptJSON, maskCard, groupCard, last4, luhnValid, cardNetwork } from '../crypto.js';
import { topbar } from '../app.js';

let host = null;
let sessionPin = null;                 // held in memory only, cleared on reload

export async function render(root) { host = root; draw(); }
export function refresh() { if (host) draw(); }

function draw() {
  host.innerHTML = '';
  host.append(topbar('Card Vault',
    sessionPin ? el('button', { class: 'btn sm ghost', onclick: () => { sessionPin = null; draw(); } }, '🔒 Lock') : null,
    el('button', { class: 'btn sm primary', onclick: () => edit() }, '+ Card')));

  host.append(el('div', { class: 'warn-box', style: 'margin-bottom:12px' },
    el('b', {}, 'Before you fill these in: '),
    'the card number and expiry are safe enough here — they are encrypted on this device with a PIN that never reaches the server. ',
    el('b', {}, 'The CVV is the one to think twice about'),
    ' — number + expiry + CVV together is everything an online shop needs. The field exists because you asked for it; ' +
    'leaving it blank costs you almost nothing in day-to-day use.'));

  if (!DB.cards.length) {
    host.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '💳'),
      el('p', {}, 'No cards saved yet.'),
      el('button', { class: 'btn primary', onclick: () => edit() }, 'Add a card')));
    return;
  }

  const grid = el('div', { class: 'grid g2' });
  for (const c of DB.cards) {
    const face = el('div', { class: 'card-face ' + (c.kind === 'credit' ? 'credit' : '') },
      el('div', { class: 'row' }, el('b', {}, c.label), el('div', { class: 'spacer' }),
        el('span', { class: 'small' }, c.network || '')),
      el('div', { class: 'num mono', dataset: { num: '1' } }, maskCard('••••••••••••' + (c.last4 || '0000'))),
      el('div', { class: 'foot' },
        el('span', {}, c.bank || ''),
        el('span', {}, c.expiry_hint ? 'exp ' + c.expiry_hint : '')));
    const actions = el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { class: 'btn sm', onclick: () => reveal(c, face) }, '👁 Reveal'),
      el('button', { class: 'btn sm ghost', onclick: () => edit(c) }, '✎ Edit'));
    if (c.expiry_hint) {
      const [mm, yy] = c.expiry_hint.split('/').map(s => s.trim());
      if (mm && yy) {
        const exp = `20${yy}-${String(mm).padStart(2, '0')}-28`;
        const left = daysBetween(todayISO(), exp);
        if (left < 90) actions.append(el('span', { class: 'chip', style: 'color:var(--critical)' },
          left < 0 ? 'expired' : `expires in ${left} days`));
      }
    }
    grid.append(el('div', { class: 'card' }, face, actions));
  }
  host.append(grid);
}

async function askPin(reason = 'Enter your vault PIN') {
  if (sessionPin) return sessionPin;
  return new Promise(res => {
    const pin = el('input', { type: 'password', inputmode: 'numeric', placeholder: '••••••',
      style: 'text-align:center;font-size:22px;letter-spacing:.4em' });
    const remember = el('input', { type: 'checkbox', checked: true });
    const m = modal('🔐 Vault PIN', el('div', { class: 'grid', style: 'gap:10px' },
      el('p', { class: 'small muted' }, reason + '. This PIN is not stored anywhere — if you forget it the card data cannot be recovered.'),
      pin,
      el('label', { class: 'row small', style: 'gap:8px' }, remember, ' keep it unlocked until I close the app')),
      { footer: [el('button', { class: 'btn primary', onclick: () => {
        const v = pin.value; m.close();
        if (remember.checked) sessionPin = v;
        res(v);
      } }, 'Unlock')] });
    m.wrap.addEventListener('click', e => { if (e.target === m.wrap) res(null); });
    pin.addEventListener('keydown', e => { if (e.key === 'Enter') m.box.querySelector('.btn.primary').click(); });
    setTimeout(() => pin.focus(), 60);
  });
}

async function reveal(c, face) {
  if (!c.enc_blob) return toast('Nothing encrypted on this card yet', 'warn');
  const pin = await askPin('Reveal ' + c.label);
  if (!pin) return;
  let data;
  try { data = await decryptJSON({ blob: c.enc_blob, iv: c.enc_iv, salt: c.enc_salt }, pin); }
  catch { sessionPin = null; return toast('Wrong PIN', 'err'); }

  const line = (l, v, copy = true) => v ? el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--grid)' },
    el('span', { class: 'muted small' }, l),
    el('span', { class: 'row', style: 'gap:6px' }, el('b', { class: 'mono' }, v),
      copy ? el('button', { class: 'icon-btn', title: 'Copy', onclick: () => { navigator.clipboard?.writeText(v); toast('Copied — clears in 30s'); setTimeout(() => navigator.clipboard?.writeText(' '), 30000); } }, '⧉') : null)) : null;

  modal(c.label, el('div', {},
    line('Card number', groupCard(data.number)),
    line('Expiry', data.expiry),
    line('CVV', data.cvv),
    line('ATM PIN', data.pin),
    line('Name on card', data.holder, false),
    data.note ? el('p', { class: 'small muted', style: 'margin-top:10px' }, data.note) : null,
    el('p', { class: 'hint', style: 'margin-top:12px' }, 'Close this when you are done — nothing here is written to the screen again until you unlock.')));
}

function edit(c = null) {
  const isNew = !c;
  const v = c || { label: '', bank: '', network: '', kind: 'debit', last4: '', expiry_hint: '' };
  const label = el('input', { value: v.label, placeholder: 'Fed Bank Debit' });
  const bank = el('input', { value: v.bank || '', placeholder: 'Federal Bank' });
  const kind = el('select', {}, el('option', { value: 'debit', selected: v.kind !== 'credit' }, 'Debit'),
    el('option', { value: 'credit', selected: v.kind === 'credit' }, 'Credit'));
  const number = el('input', { inputmode: 'numeric', placeholder: isNew ? '•••• •••• •••• ••••' : 'leave blank to keep what is saved', class: 'mono' });
  const expiry = el('input', { placeholder: 'MM/YY', class: 'mono', value: v.expiry_hint || '' });
  const cvv = el('input', { inputmode: 'numeric', placeholder: 'optional — read the warning', class: 'mono', maxlength: 4 });
  const atmpin = el('input', { inputmode: 'numeric', placeholder: 'optional', class: 'mono', maxlength: 6 });
  const holder = el('input', { placeholder: 'Name printed on the card' });
  const note = el('input', { placeholder: 'Anything else (limit, branch, helpline…)' });
  const netHint = el('span', { class: 'hint' });
  number.addEventListener('input', () => {
    const n = cardNetwork(number.value);
    netHint.textContent = number.value.replace(/\D/g, '').length >= 12
      ? (luhnValid(number.value) ? `✓ looks like a valid ${n || 'card'} number` : '⚠ that number fails the checksum — typo?')
      : '';
  });
  const fld = (l, n, cls = '', hint) => el('div', { class: 'field ' + cls }, el('label', {}, l), n, hint || null);
  const body = el('div', { class: 'form-grid' },
    fld('Label', label), fld('Bank', bank),
    fld('Type', kind), fld('Expiry (MM/YY)', expiry),
    fld('Card number', number, 'full', netHint),
    fld('CVV', cvv, '', el('span', { class: 'hint', style: 'color:var(--serious)' }, 'Optional. Safer left empty.')),
    fld('ATM PIN', atmpin),
    fld('Name on card', holder, 'full'),
    fld('Note', note, 'full'),
    el('p', { class: 'hint full' }, 'Label, bank, network and the last 4 digits stay readable so you can tell cards apart. Everything else is encrypted before it leaves this device.'));

  const m = modal(c ? 'Edit card' : 'New card', body, {
    footer: [
      c ? el('button', { class: 'btn ghost', style: 'margin-right:auto;color:var(--critical)',
        onclick: async () => { if (await confirmBox('Delete this card and its encrypted data?')) { await remove('cards', c.id); m.close(); } } }, 'Delete') : null,
      el('button', { class: 'btn primary', onclick: save }, 'Save'),
    ].filter(Boolean),
  });

  async function save() {
    if (!label.value.trim()) return toast('Give the card a label', 'warn');
    const hasSecret = number.value || cvv.value || atmpin.value || holder.value || note.value;
    let patch = {
      ...v, label: label.value.trim(), bank: bank.value.trim(), kind: kind.value,
      network: cardNetwork(number.value) || v.network || '',
      expiry_hint: expiry.value.trim() || v.expiry_hint || '',
      last4: number.value ? last4(number.value) : v.last4,
    };
    if (hasSecret) {
      const pin = await askPin('Set (or enter) the PIN that locks this vault');
      if (!pin) return;
      if (pin.length < 4) return toast('Use at least 4 characters', 'warn');
      let existing = {};
      if (c?.enc_blob && !number.value) {
        try { existing = await decryptJSON({ blob: c.enc_blob, iv: c.enc_iv, salt: c.enc_salt }, pin); }
        catch { sessionPin = null; return toast('Wrong PIN for this card', 'err'); }
      }
      const payload = {
        number: number.value.replace(/\s/g, '') || existing.number || '',
        expiry: expiry.value.trim() || existing.expiry || '',
        cvv: cvv.value.trim() || existing.cvv || '',
        pin: atmpin.value.trim() || existing.pin || '',
        holder: holder.value.trim() || existing.holder || '',
        note: note.value.trim() || existing.note || '',
      };
      const enc = await encryptJSON(payload, pin);
      patch = { ...patch, enc_blob: enc.blob, enc_iv: enc.iv, enc_salt: enc.salt, last4: last4(payload.number) || patch.last4 };
    }
    await put('cards', patch);
    toast('Saved');
    m.close();
  }
}
