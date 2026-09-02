// ============================================================================
//  crypto.js — the card vault.
//
//  Card data is encrypted IN YOUR BROWSER with a key derived from a PIN that
//  never leaves the device (PBKDF2-SHA256, 250k iterations → AES-256-GCM).
//  Supabase stores only ciphertext. Anyone reading the database — including
//  Supabase itself — sees random bytes.
//
//  Trade-off you should know about: forget the PIN and the card data is gone
//  for good. There is no reset, by design.
// ============================================================================
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt an object. Returns { blob, iv, salt } — all base64. */
export async function encryptJSON(obj, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { blob: b64(ct), iv: b64(iv), salt: b64(salt) };
}

/** Decrypt. Throws if the PIN is wrong (GCM auth tag fails). */
export async function decryptJSON({ blob, iv, salt }, pin) {
  const key = await deriveKey(pin, unb64(salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(blob));
  return JSON.parse(dec.decode(pt));
}

// --------------------------------------------------------- app lock (PIN) --
// A separate, simpler thing: a screen lock so a borrowed phone can't browse
// your ledger. Only a hash is stored, and only on this device.
export async function hashPin(pin, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  const raw = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12) }, key, enc.encode('jinnyfin-lock'));
  return { hash: b64(raw), salt: b64(salt) };
}
export async function checkPin(pin, saltB64, hashB64) {
  try { return (await hashPin(pin, saltB64)).hash === hashB64; } catch { return false; }
}

// ---------------------------------------------------------------- helpers --
export const maskCard = n => {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length < 4) return '••••';
  return '•••• •••• •••• ' + d.slice(-4);
};
export const groupCard = n => String(n || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
export const last4 = n => String(n || '').replace(/\D/g, '').slice(-4);

/** Luhn check — catches typos before you save a wrong number. */
export function luhnValid(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length < 12) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let v = +d[i];
    if (alt) { v *= 2; if (v > 9) v -= 9; }
    sum += v; alt = !alt;
  }
  return sum % 10 === 0;
}
export function cardNetwork(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (/^4/.test(d)) return 'Visa';
  if (/^5[1-5]|^2[2-7]/.test(d)) return 'Mastercard';
  if (/^3[47]/.test(d)) return 'Amex';
  if (/^6(?:0|5|8)/.test(d)) return 'RuPay';
  if (/^(?:4|5)[0-9]{5}/.test(d) && d.length === 16) return 'Mada';
  return '';
}
