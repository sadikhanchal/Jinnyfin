#!/usr/bin/env node
// Step 5 gate: direct REST/RLS isolation test.
//
// This deliberately does not use the Jinnyfin UI or supabase-js. It creates two
// throwaway users through Supabase's normal /auth/v1/signup endpoint, then uses
// only the publishable anon key plus each user's own access token against
// /rest/v1/transactions. Every request prints its actual HTTP status and body.
//
// Run from the repository root:
//   node test/rls-isolation.mjs
//
// Optional overrides are useful when testing a different demo project:
//   JF_SUPABASE_URL=... JF_SUPABASE_ANON_KEY=... node test/rls-isolation.mjs

import { readFile } from 'node:fs/promises';

const configText = await readFile(new URL('../config.js', import.meta.url), 'utf8');
const configValue = name => {
  const m = configText.match(new RegExp(name + "\\s*:\\s*['\\\"]([^'\\\"]+)['\\\"]"));
  if (!m) throw new Error('Could not read ' + name + ' from config.js');
  return m[1];
};

const BASE = (process.env.JF_SUPABASE_URL || configValue('SUPABASE_URL')).replace(/\/+$/, '');
const ANON = process.env.JF_SUPABASE_ANON_KEY || configValue('SUPABASE_ANON_KEY');
if (!BASE || !ANON || BASE.startsWith('PASTE') || ANON.startsWith('PASTE'))
  throw new Error('Supabase URL and publishable anon key are not configured');

const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const password = 'JfRls!' + crypto.randomUUID() + 'aA1';
const accounts = [];

const authHeaders = { apikey: ANON, 'content-type': 'application/json' };
const restHeaders = token => ({
  apikey: ANON,
  Authorization: 'Bearer ' + token,
  'content-type': 'application/json',
});

function parseBody(text) {
  if (!text) return '';
  try { return JSON.parse(text); } catch { return text; }
}

function redactAuth(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  for (const key of ['access_token', 'refresh_token', 'token_type', 'expires_in', 'expires_at'])
    delete copy[key];
  return copy;
}

async function request(label, method, path, token, body, options = {}) {
  const headers = token ? restHeaders(token) : authHeaders;
  if (options.prefer) headers.Prefer = options.prefer;
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseBody(text);
  const printed = options.redact ? redactAuth(parsed) : parsed;
  const record = { label, status: response.status, body: printed };
  console.log(JSON.stringify(record));
  return { ...record, rawBody: parsed };
}

function tokenFrom(result) {
  return result.rawBody && typeof result.rawBody === 'object' ? result.rawBody.access_token : null;
}

async function createThrowaway(label) {
  const email = 'jinnyfin.rls.' + label.toLowerCase() + '.' + runId + '@example.com';
  const signup = await request('sign-up ' + label, 'POST', '/auth/v1/signup', null,
    { email, password }, { redact: true });
  let token = tokenFrom(signup);
  let user = signup.rawBody && signup.rawBody.user;
  if (!token) {
    const signin = await request('sign-in ' + label, 'POST', '/auth/v1/token?grant_type=password', null,
      { email, password }, { redact: true });
    token = tokenFrom(signin);
    user = signin.rawBody && signin.rawBody.user;
  }
  if (!token || !user?.id)
    throw new Error(label + ' did not receive a session; the project may require email confirmation');
  const account = { label, email, token, id: user.id };
  accounts.push(account);
  return account;
}

const tx = (id, userId, note) => ({
  id,
  user_id: userId,
  date: '2026-09-11',
  time: '01:00',
  type: 'Expense',
  account: 'RLS Test Account',
  currency: 'SAR',
  income: 0,
  expense: 1,
  parent: 'RLS Test',
  sub: null,
  note,
  deleted: false,
});

const rowPath = id => '/rest/v1/transactions?id=eq.' + encodeURIComponent(id)
  + '&select=id,user_id,deleted,note';
const rowSelectPath = id => '/rest/v1/transactions?id=eq.' + encodeURIComponent(id)
  + '&select=id,user_id,deleted,note';

function emptyResult(result) {
  return result.status === 204 || result.body === '' || (Array.isArray(result.body) && result.body.length === 0);
}

function requireForeignBlocked(result, label) {
  if (result.status >= 200 && result.status < 300 && !emptyResult(result))
    throw new Error(label + ' returned a non-empty success result');
}

function requireOwn(result, owner, id, note) {
  const rows = result.body;
  if (result.status !== 200 || !Array.isArray(rows) || rows.length !== 1
      || rows[0].id !== id || rows[0].user_id !== owner.id
      || rows[0].deleted !== false || rows[0].note !== note)
    throw new Error(owner.label + ' could not still see its own unchanged row');
}

async function selectRow(label, account, id) {
  return request(label, 'GET', rowSelectPath(id), account.token);
}

async function runDirection(attacker, victim, victimRow, direction) {
  const injectedId = crypto.randomUUID();
  const prefix = direction + ' ' + attacker.label + ' -> ' + victim.label;
  const select = await request(prefix + ' select victim row', 'GET', rowSelectPath(victimRow.id), attacker.token);
  if (select.status !== 200 || !Array.isArray(select.body) || select.body.length !== 0)
    throw new Error(prefix + ' select was not 200 with an empty array');

  const update = await request(prefix + ' update victim row', 'PATCH', rowPath(victimRow.id), attacker.token,
    { note: 'UNAUTHORIZED UPDATE ' + attacker.label }, { prefer: 'return=representation' });
  requireForeignBlocked(update, prefix + ' update');

  const softDelete = await request(prefix + ' soft-delete victim row', 'PATCH', rowPath(victimRow.id), attacker.token,
    { deleted: true }, { prefer: 'return=representation' });
  requireForeignBlocked(softDelete, prefix + ' soft-delete');

  const insert = await request(prefix + ' insert row carrying victim user_id', 'POST', '/rest/v1/transactions', attacker.token,
    tx(injectedId, victim.id, 'UNAUTHORIZED INSERT ' + attacker.label), { prefer: 'return=representation' });
  requireForeignBlocked(insert, prefix + ' insert');

  const victimView = await selectRow(victim.label + ' verifies own row after ' + direction, victim, victimRow.id);
  requireOwn(victimView, victim, victimRow.id, victimRow.note);
  const injectedView = await selectRow(victim.label + ' checks unauthorized id after ' + direction, victim, injectedId);
  if (injectedView.status !== 200 || !Array.isArray(injectedView.body) || injectedView.body.length !== 0)
    throw new Error(prefix + ' inserted row became visible to the victim');
}

try {
  const a = await createThrowaway('A');
  const b = await createThrowaway('B');
  console.log(JSON.stringify({ label: 'test accounts', status: 'created', body: { A: 'throwaway', B: 'throwaway' } }));

  const aId = crypto.randomUUID();
  const bId = crypto.randomUUID();
  const aNote = 'RLS owner A';
  const bNote = 'RLS owner B';
  const aWrite = await request('A writes own transaction', 'POST', '/rest/v1/transactions', a.token,
    tx(aId, a.id, aNote), { prefer: 'return=representation' });
  if (aWrite.status < 200 || aWrite.status >= 300) throw new Error('A could not write its own transaction');
  const bWrite = await request('B writes own transaction', 'POST', '/rest/v1/transactions', b.token,
    tx(bId, b.id, bNote), { prefer: 'return=representation' });
  if (bWrite.status < 200 || bWrite.status >= 300) throw new Error('B could not write its own transaction');

  await runDirection(b, a, { id: aId, note: aNote }, 'forward');
  await runDirection(a, b, { id: bId, note: bNote }, 'reverse');

  const aOwn = await selectRow('A final own-row visibility', a, aId);
  const bOwn = await selectRow('B final own-row visibility', b, bId);
  requireOwn(aOwn, a, aId, aNote);
  requireOwn(bOwn, b, bId, bNote);
  console.log(JSON.stringify({ label: 'RLS isolation result', status: 'PASS', body: {
    cross_account_select_update_soft_delete_insert: 'blocked-or-empty-both-directions',
    own_rows_visible_unchanged: true,
  }}));
} finally {
  for (const account of accounts) {
    try { await request('sign-out ' + account.label, 'POST', '/auth/v1/logout', account.token, undefined, { redact: true }); }
    catch (e) { console.error(JSON.stringify({ label: 'sign-out ' + account.label, status: 'error', body: String(e) })); }
  }
}
