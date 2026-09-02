-- ============================================================================
--  Jinnyfin 1.18 — the reminders table.
--  Supabase → SQL Editor → New query → paste → Run. Safe to run twice.
--  (If you have not run migration-1.17.sql yet, run that one first.)
-- ============================================================================

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

-- Same rules as every other table: your rows, nobody else's.
drop trigger if exists touch_tasks on public.tasks;
create trigger touch_tasks before insert or update on public.tasks
  for each row execute function public.touch_row();
alter table public.tasks enable row level security;
drop policy if exists own_rows on public.tasks;
create policy own_rows on public.tasks
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

notify pgrst, 'reload schema';
