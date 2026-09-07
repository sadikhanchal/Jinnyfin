// ============================================================================
//  files.js — attachments for the things in Insurance & Documents.
//
//  The invoice and the warranty card for a machine are worth nothing in a
//  drawer at home when the shop asks for them here. They live in a private
//  Supabase bucket, one folder per person, and are only ever handed out through
//  a link that expires — nothing in this app is world-readable.
//
//  Deliberately NOT offline-first, unlike the rest of Jinnyfin: a scanned
//  invoice is megabytes, the ledger is kilobytes, and filling the phone's
//  offline store with paperwork would cost more than it is worth. Uploading and
//  opening need a connection, and say so plainly when there is none.
// ============================================================================
import { state, initSupabase } from './store.js';

const BUCKET = 'docs';

/** 15 MB. A phone photo of an invoice is 2–5; a scanned PDF rarely more. */
export const MAX_BYTES = 15 * 1024 * 1024;

const OK_TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;

export const prettySize = n =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Strip anything that would upset a storage path, keep it recognisable. */
function safeName(name) {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const ext = (dot > 0 ? name.slice(dot + 1) : '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8).toLowerCase();
  return (stem || 'file') + (ext ? '.' + ext : '');
}

/** What is wrong with this file, or null if nothing is. */
export function reject(file) {
  if (!file) return 'No file.';
  if (file.size > MAX_BYTES) return `That is ${prettySize(file.size)} — the limit is ${prettySize(MAX_BYTES)}.`;
  if (!OK_TYPES.test(file.type || '')) return 'Only photos (JPG, PNG, WebP, HEIC) and PDFs.';
  return null;
}

/**
 * Put one file in the bucket and describe it back.
 * The record id is in the path, so an attachment is findable from the file
 * store alone if this table is ever rebuilt from a backup.
 */
export async function upload(file, recordId) {
  const bad = reject(file);
  if (bad) return { ok: false, why: bad };
  if (!navigator.onLine) return { ok: false, why: 'No connection — attachments need one.' };
  const sb = await initSupabase();
  if (!sb || !state.user) return { ok: false, why: 'Sign in first.' };

  const path = `${state.user.id}/${recordId}/${Date.now()}-${safeName(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    return { ok: false, why: /bucket/i.test(error.message)
      ? 'The docs bucket is missing — run migration-1.27.sql.'
      : 'Upload failed: ' + error.message };
  }
  return { ok: true, file: { path, name: file.name, size: file.size, type: file.type, added: new Date().toISOString() } };
}

/**
 * A link to look at one, good for an hour.
 * Short-lived on purpose: this is how a warranty card gets shown to a service
 * desk, and a link that works forever is a link that leaks forever.
 */
export async function link(path, { download = false } = {}) {
  if (!navigator.onLine) return { ok: false, why: 'No connection — attachments need one.' };
  const sb = await initSupabase();
  if (!sb) return { ok: false, why: 'Sign in first.' };
  const { data, error } = await sb.storage.from(BUCKET)
    .createSignedUrl(path, 3600, download ? { download: true } : undefined);
  if (error || !data?.signedUrl) return { ok: false, why: 'Could not open it: ' + (error?.message || 'unknown') };
  return { ok: true, url: data.signedUrl };
}

/** Take one out of the bucket. Losing the row without this leaves litter. */
export async function remove(path) {
  const sb = await initSupabase();
  if (!sb) return { ok: false, why: 'Sign in first.' };
  const { error } = await sb.storage.from(BUCKET).remove([path]);
  return error ? { ok: false, why: error.message } : { ok: true };
}
