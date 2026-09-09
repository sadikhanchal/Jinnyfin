-- ============================================================================
--  The timer that makes reminders arrive with the app closed.
--
--  Run this AFTER the jinnyfin-push function is deployed, and after step 4a
--  below. Nothing in this file needs editing.
--
--  Why it sends TWO headers: Supabase's gateway wants `apikey` to let the call
--  through at all, and `Authorization` to say who is calling. The app sends both
--  and works; a call carrying only one of them comes straight back as 401
--  without ever reaching the function. Both are the same service key here.
--
--  Runs every five minutes: ~8,600 calls a month against a free-tier allowance
--  of 500,000. Most runs find nothing due, log a line, and stop.
-- ============================================================================

-- ---------------------------------------------------------------- step 4a --
-- Put the service_role key in the vault, ONCE, so it is not written into the
-- job definition in plain text.
--
--   Supabase → Project Settings → API Keys → Legacy API keys
--   Copy `service_role` — the long one starting with  eyJ…
--
-- Then, in the SQL editor, run this ONE line with your key pasted in:
--
--   select vault.create_secret('eyJhbGciOi…PASTE-THE-WHOLE-THING…', 'service_role_key');
--
-- Paste it into the SQL editor only. Do NOT put it in this file, and do not
-- commit it anywhere — unlike the publishable key, service_role ignores every
-- Row Level Security rule and can read and write everything you own.
--
-- To check it landed:   select name from vault.secrets;
-- To replace it later:  select vault.update_secret(
--                         (select id from vault.secrets where name = 'service_role_key'),
--                         'new-key-here');

-- ---------------------------------------------------------------- step 4b --
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Running this file again replaces the job instead of adding a second one.
select cron.unschedule('jinnyfin-push')
where exists (select 1 from cron.job where jobname = 'jinnyfin-push');

select cron.schedule(
  'jinnyfin-push',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://rghhuttvobghtkthpsej.supabase.co/functions/v1/jinnyfin-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey',
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- ---------------------------------------------------------------- checking --
-- Is it scheduled?
--     select jobname, schedule, active from cron.job;
--
-- Did the last few runs work? status should read 'succeeded'.
--     select status, return_message, start_time
--       from cron.job_run_details
--      where jobid = (select jobid from cron.job where jobname = 'jinnyfin-push')
--      order by start_time desc limit 10;
--
-- What did the function itself answer? net.http_post is fire-and-forget, so the
-- reply lands in its own table — a 200 here means the sweep really ran.
--     select id, status_code, content, created
--       from net._http_response order by created desc limit 10;
--
-- Stop it again:
--     select cron.unschedule('jinnyfin-push');
