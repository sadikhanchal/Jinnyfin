# Push notifications — one-time setup

Reminders that reach your phone **with Jinnyfin closed**. Four steps, all in the
browser. Nothing to install, no command line.

The chain: your phone agrees to listen → the address is stored in Supabase → a
job on Supabase's servers checks every five minutes → anything due is posted to
your phone → Android draws the notification and plays its notification sound.

---

## 1 · Make the tables

Supabase → **SQL Editor** → **New query** → paste all of
`supabase/migration-1.26.sql` → **Run**.

Safe to run twice. It creates `push_subscriptions` (which device to knock on)
and `push_log` (what has already rung, so a reminder does not repeat every five
minutes).

---

## 2 · Put the secret key where only the server can see it

Supabase → **Edge Functions** → **Secrets** (also under Project Settings →
Edge Functions) → add these three:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | `BL94JGN2xGkX7_6nHUietV0IUMcXAU_Zfvl0vSRjmVlwjeY3nFiQ_fM3mFQCvqH662AOiCjUtqxeN_REBify-Jg` |
| `VAPID_PRIVATE_KEY` | `60XXwqC5JbiMc87ZZ6KFJsVgo17bv9UOUCkj3CdFAzU` |
| `VAPID_SUBJECT` | `mailto:sadikhanchal@gmail.com` |

The **public** key is also in `config.js` — that one is meant to be public; it is
what the phone uses to check a notification really came from Jinnyfin.

The **private** key must live only here. It is not in the repository and must not
be put there. Anyone holding it could send notifications to your phone —
annoying rather than dangerous, no money and no data are reachable with it, but
keep it to yourself. You can replace the pair at any time: generate a new one,
update both places, and every device simply subscribes again.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already there — Supabase adds
them to every function by itself. You do not create those.

---

## 3 · Deploy the function

Supabase → **Edge Functions** → **Deploy a new function** → **Open editor**.

The editor opens with a function already named something random like
`clever-endpoint`, holding a sample `index.ts`. That is the new function — it is
not somebody else's. So:

1. Click the name **`clever-endpoint`** at the bottom and change it to exactly
   **`jinnyfin-push`**.
2. Click into the existing **`index.ts`**, select everything (Ctrl+A) and paste
   the whole of `supabase/functions/jinnyfin-push/index.ts` over it.
3. **Deploy.**

Do **not** use "+ Add file". One file, and it has to keep the name `index.ts` —
that is the file Supabase runs.

That's it — no settings to change.

---

## 4 · Start the timer

**4a — put the service_role key in the vault.** The timer needs a key the
function will accept.

Supabase → **Project Settings** → **API Keys** → **Legacy API keys** → copy
`service_role` (the long one starting `eyJ…`). Then in the **SQL Editor** run
this single line, with your key pasted in:

```sql
select vault.create_secret('eyJhbGciOi…PASTE-THE-WHOLE-KEY…', 'service_role_key');
```

Paste it into the SQL editor only. That key must never go into the repository or
into `config.js` — unlike the publishable key, `service_role` ignores every Row
Level Security rule and can read and write everything in your account. In the
vault it is encrypted, and only the scheduled job reads it.

Check it landed: `select name from vault.secrets;` should list
`service_role_key`.

**4b — schedule it.** Supabase → **SQL Editor** → paste all of
`supabase/push-cron.sql` → **Run**. Nothing in that file needs editing.

It turns on the two extensions the timer needs (`pg_cron`, `pg_net`) and books a
call every five minutes.

Confirm it is booked:

```sql
select jobname, schedule, active from cron.job;
```

---

## Then, on the phone

1. Open Jinnyfin, sign in.
2. **Insurance & Documents** → the reminders card → **Push to this device** →
   **Turn on**. Allow notifications when Chrome asks.
3. Tap **Test**. A notification should arrive within a few seconds.

Do the same on the PC if you want it there too — each device says yes for
itself, so turning it off on one leaves the others alone.

### About the sound

The notification plays **the phone's own notification sound**. A web app is not
allowed to ship its own tone — that part of the notification API does not exist.
What you *can* do, on Android: **Settings → Apps → Jinnyfin → Notifications**,
and give it whatever tone you like. Android treats an installed PWA as a real app
for this, so it gets its own entry and its own tone.

### If nothing arrives

- **Chrome, phone**: Settings → Site settings → Notifications → the Jinnyfin
  entry must be "Allowed". Android's own Settings → Apps → Jinnyfin →
  Notifications must be on as well.
- **Battery saver** can hold notifications back. Settings → Apps → Jinnyfin →
  Battery → **Unrestricted** fixes it.
- **Nothing at all, on any device**: work backwards through the chain.

  1. Is the timer firing? In the SQL editor:

     ```sql
     select status, return_message, start_time
       from cron.job_run_details
      where jobid = (select jobid from cron.job where jobname = 'jinnyfin-push')
      order by start_time desc limit 10;
     ```

     `succeeded` means the call left the database.

  2. What did the function answer? The call is fire-and-forget, so the reply
     lands in its own table:

     ```sql
     select status_code, content, created from net._http_response
      order by created desc limit 10;
     ```

     **Read `created` before anything else.** That table keeps old replies, so
     the 401 at the top may be from before a fix — it has to be newer than the
     change you just made to count.

     `200` is right. **`401`** means the call never reached the function: the
     key in step 4a is missing or wrong (`select name from vault.secrets;`), or
     the job is not sending both `apikey` and `Authorization`. Re-running
     `push-cron.sql` restores both. **`404`** means the function name is not
     exactly `jinnyfin-push`.

  3. What did it do? Supabase → Edge Functions → `jinnyfin-push` → **Logs**.
     Each run prints how many people it looked at and how many messages went
     out.

### iPhone, if you ever use one

iOS only offers push to a PWA that has been **added to the Home Screen** —
Share → Add to Home Screen — and opened from there. In a Safari tab the
"Turn on" button will not appear, and the card says why.
