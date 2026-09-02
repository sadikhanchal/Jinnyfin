-- ============================================================================
--  JINNYFIN  ·  Supabase schema
--  Run this ONCE in Supabase → SQL Editor → New query → paste → Run.
--  Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- helpers --
create or replace function public.touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.user_id is null then new.user_id = auth.uid(); end if;
  return new;
end $$;

-- Every table gets: id (uuid, client-generated), user_id, updated_at, deleted.
-- Sync = "give me every row where updated_at > my last sync".
-- Deletes are soft (deleted = true) so other devices learn about them.

-- ---------------------------------------------------------------- tables ---

create table if not exists public.accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  name         text not null,
  currency     text not null default 'SAR',           -- SAR | INR | USD
  grp          text not null default 'primary',       -- primary | investment | other
  opening_bal  numeric not null default 0,
  active       boolean not null default true,
  pinned       boolean not null default false,        -- always show, whatever the idle rule says
  created_at   date,                                  -- a new account gets 60 days before it can be judged idle
  stated_balance numeric,                             -- what your bank app said, from Reconcile
  reconciled_at  date,                                -- when you last ticked it off
  sort         int not null default 0,
  icon         text,
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  type        text not null,                          -- Income|Expense|Lend/Borrow|Investment|Transfer|Opening Balance
  parent      text not null,
  sub         text,
  icon        text,
  color       text,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.payees (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  note        text,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  no          int,                                    -- original running number from the workbook
  date        date not null,
  time        text,                                   -- 'HH:MM'
  type        text not null,                          -- Income|Expense|Transfer|Lend/Borrow|Investment|Opening Balance
  account     text not null,
  currency    text not null default 'SAR',
  income      numeric not null default 0,
  expense     numeric not null default 0,
  parent      text,
  sub         text,
  payee       text,
  event       text,
  note        text,
  fx          numeric not null default 1,             -- historical SAR->INR rate for this row's month
  transfer_group uuid,                                -- both legs of a transfer share this
  to_account  text,                                   -- where a transfer went, so the app never has to guess
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.fx_rates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  month       date not null,                          -- first day of the month
  rate        numeric not null,                       -- SAR -> INR
  source      text,                                   -- 'Actual' | 'Interpolated' | 'Manual'
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  name          text not null,
  category_tag  text,                                 -- expense parent category that feeds its cost
  opening_cost  numeric not null default 0,           -- cost incurred before the ledger started
  market_value  numeric not null default 0,           -- 0 = use cost
  market_date   date,
  note          text,
  deleted       boolean not null default false,
  updated_at    timestamptz not null default now()
);

create table if not exists public.insurance (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  label         text not null,                        -- Car / Health / Scooty ...
  policy        text,                                 -- insurer or policy name
  policy_no     text,
  renewal_date  date not null,
  premium       numeric default 0,
  currency      text default 'INR',
  notify_days   int not null default 30,
  kind          text not null default 'insurance',    -- insurance | document  (iqama, passport, licence…)
  pay_account   text,                                 -- which account paid the last premium
  last_paid     date,
  note          text,
  deleted       boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- Card vault. The server NEVER sees readable card data:
-- enc_blob is AES-GCM ciphertext produced in the browser from a PIN only you know.
create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  label       text not null,                          -- "Fed Bank Debit"
  bank        text,
  network     text,                                   -- Visa / Mastercard / RuPay / Mada
  kind        text default 'debit',                   -- debit | credit
  last4       text,                                   -- plain, for identifying the card at a glance
  expiry_hint text,                                   -- plain 'MM/YY' if you want the renewal reminder
  enc_blob    text,                                   -- base64 AES-GCM ciphertext (number, expiry, cvv, pin, notes)
  enc_iv      text,
  enc_salt    text,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.equity_positions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  symbol      text not null,
  company     text,
  qty         numeric not null default 0,
  avg_cost    numeric not null default 0,
  price       numeric not null default 0,
  price_date  date,
  closed      boolean not null default false,
  buy_qty     numeric default 0,
  buy_value   numeric default 0,
  sell_qty    numeric default 0,
  sell_value  numeric default 0,
  realised    numeric default 0,
  dividends   numeric default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.equity_trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  date        date not null,
  symbol      text not null,
  company     text,
  exchange    text,
  action      text,                                   -- Buy | Sell
  qty         numeric default 0,
  rate        numeric default 0,
  value       numeric default 0,
  source      text,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.businesses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  name            text not null,
  income_parent   text,
  income_sub      text,
  expense_parent  text,
  expense_sub     text,
  deleted         boolean not null default false,
  updated_at      timestamptz not null default now()
);

create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  parent      text not null,
  sub         text,
  amount      numeric not null default 0,
  currency    text not null default 'INR',
  period      text not null default 'monthly',        -- monthly | yearly
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- Frequently repeated entries you can fire with one tap.
create table if not exists public.templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  label       text not null,
  payload     jsonb not null default '{}'::jsonb,
  sort        int not null default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  note        text,
  due_date    date,
  due_time    text,                                   -- 'HH:MM'
  repeat      text not null default 'none',           -- none | daily | weekly | monthly | yearly
  priority    text not null default 'normal',         -- low | normal | high
  done        boolean not null default false,
  done_at     timestamptz,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.settings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique default auth.uid() references auth.users on delete cascade,
  data        jsonb not null default '{}'::jsonb,     -- rates, theme, push subscription, prefs
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- indexes ---
create index if not exists tx_user_date_idx   on public.transactions (user_id, date);
create index if not exists tx_user_upd_idx    on public.transactions (user_id, updated_at);
create index if not exists tx_user_acct_idx   on public.transactions (user_id, account);
create index if not exists tx_user_parent_idx on public.transactions (user_id, parent);
create index if not exists tx_user_payee_idx  on public.transactions (user_id, payee);
create index if not exists fx_user_month_idx  on public.fx_rates (user_id, month);

-- ------------------------------------------------------- triggers + RLS ----
do $$
declare t text;
begin
  foreach t in array array['accounts','categories','payees','transactions','fx_rates','assets',
                           'insurance','cards','equity_positions','equity_trades','businesses',
                           'budgets','templates','tasks','settings']
  loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before insert or update on public.%1$s
                    for each row execute function public.touch_row()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists own_rows on public.%1$s', t);
    execute format('create policy own_rows on public.%1$s
                    for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ------------------------------------------------- server-side reporting ---
-- One round trip for the alert e-mail / cron job: what is expiring soon?
create or replace function public.expiring_soon(days int default 45)
returns table(label text, policy text, renewal_date date, days_left int)
language sql security invoker stable as $$
  select label, policy, renewal_date, (renewal_date - current_date)::int
  from public.insurance
  where deleted = false and user_id = auth.uid()
    and renewal_date - current_date <= days
  order by renewal_date
$$;

-- ============================================================================
--  Done. Next: Authentication → Users → Add user (your e-mail + a password),
--  then open the app and sign in with it.
-- ============================================================================
