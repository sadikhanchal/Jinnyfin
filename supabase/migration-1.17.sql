-- ============================================================================
--  Jinnyfin 1.17 — columns the app writes that the first schema did not have.
--  Run this once in Supabase → SQL Editor → New query → Run.
--  Safe to run twice: every line is "if not exists".
-- ============================================================================

-- Reconcile: what your bank app said, and when you last ticked the account off.
alter table public.accounts add column if not exists stated_balance numeric;
alter table public.accounts add column if not exists reconciled_at  date;
-- The 60-day idle rule needs to know when an account was born, and "pinned"
-- is the account you always want on screen whatever the rule says.
alter table public.accounts add column if not exists created_at     date;
alter table public.accounts add column if not exists pinned         boolean not null default false;

-- Renewing a policy records which account paid the premium, and when.
alter table public.insurance add column if not exists pay_account text;
alter table public.insurance add column if not exists last_paid   date;

-- A transfer now remembers where it went, instead of the app guessing.
alter table public.transactions add column if not exists to_account text;

-- PostgREST keeps its own copy of the column list; without this it can keep
-- answering "could not find the column ... in the schema cache" for a minute.
notify pgrst, 'reload schema';
