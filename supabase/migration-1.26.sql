-- ============================================================================
--  Jinnyfin 1.26 — push notifications
--
--  Run this ONCE in Supabase → SQL Editor → New query → Run.
--  It is safe to run twice; nothing is dropped and nothing is overwritten.
-- ============================================================================

-- Where a device says "send my reminders here". One row per browser, per
-- device. The endpoint is the address the phone's push service listens on; the
-- two keys let the server encrypt the message so only that device can read it.
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  label       text,                                  -- "Pixel 8 · Chrome", so you can tell them apart
  last_seen   timestamptz not null default now(),
  failures    int not null default 0,                -- dropped after a few refusals
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- One device cannot subscribe twice; re-subscribing updates the row it has.
create unique index if not exists push_subscriptions_endpoint_key
  on public.push_subscriptions (endpoint);

-- What has already been sent, so a reminder rings once and not every five
-- minutes until you deal with it. `alert_key` is the same id the app's bell
-- uses, so the two agree about what "this alert" means.
create table if not exists public.push_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  alert_key   text not null,
  sent_at     timestamptz not null default now()
);
create unique index if not exists push_log_once
  on public.push_log (user_id, alert_key);
create index if not exists push_log_sent_at on public.push_log (sent_at);

-- ---------------------------------------------------------------- security --
-- Same rule as every other table: you can only ever see your own rows. The
-- scheduled job does not go through this — it uses the service key, which is
-- why that key lives in Supabase's secret store and never in the app.
alter table public.push_subscriptions enable row level security;
alter table public.push_log           enable row level security;

do $$ begin
  create policy "own push subscriptions" on public.push_subscriptions
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own push log" on public.push_log
    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Keep updated_at honest, the same way every other table does.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists push_subscriptions_touch on public.push_subscriptions;
create trigger push_subscriptions_touch before update on public.push_subscriptions
  for each row execute function public.touch_updated_at();

-- Tell PostgREST the shape of the database changed.
notify pgrst, 'reload schema';
