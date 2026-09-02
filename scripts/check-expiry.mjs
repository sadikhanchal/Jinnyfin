// ============================================================================
//  check-expiry.mjs — run daily by GitHub Actions.
//  Signs in to Supabase, reads the insurance table, and e-mails whatever is
//  inside its own notify window. No mail is sent when nothing is due.
// ============================================================================
const { SUPABASE_URL, SUPABASE_ANON_KEY, JINNYFIN_EMAIL, JINNYFIN_PASSWORD, RESEND_API_KEY, MAIL_TO } = process.env;

if (!SUPABASE_URL || !JINNYFIN_EMAIL) { console.error('Missing secrets — see the workflow file.'); process.exit(1); }

const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: JINNYFIN_EMAIL, password: JINNYFIN_PASSWORD }),
}).then(r => r.json());
if (!auth.access_token) { console.error('Sign-in failed:', auth); process.exit(1); }

const rows = await fetch(`${SUPABASE_URL}/rest/v1/insurance?deleted=eq.false&select=*`, {
  headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${auth.access_token}` },
}).then(r => r.json());

const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const days = d => Math.round((Date.parse(d + 'T00:00:00Z') - today) / 86400000);

const due = rows
  .map(p => ({ ...p, left: days(p.renewal_date) }))
  .filter(p => p.left <= (p.notify_days || 30))
  .sort((a, b) => a.left - b.left);

if (!due.length) { console.log('Nothing due. No mail sent.'); process.exit(0); }

const line = p => p.left < 0
  ? `⛔ ${p.label} (${p.policy || ''}) EXPIRED ${-p.left} days ago — ${p.renewal_date}`
  : `⚠ ${p.label} (${p.policy || ''}) renews in ${p.left} days — ${p.renewal_date}`;

const text = ['Renewals coming up:', '', ...due.map(line), '', 'Open Jinnyfin to update them.'].join('\n');
console.log(text);

if (RESEND_API_KEY && MAIL_TO) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Jinnyfin <onboarding@resend.dev>',
      to: [MAIL_TO],
      subject: `Jinnyfin · ${due[0].left < 0 ? 'EXPIRED' : `${due[0].label} renews in ${due[0].left} days`}`,
      text,
    }),
  });
  console.log('Mail status', r.status, await r.text());
} else {
  console.log('No mailer configured — the reminder is in this log only.');
}
