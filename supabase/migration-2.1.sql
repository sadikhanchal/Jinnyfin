-- ============================================================================
--  Jinnyfin 2.1 — insurance & document cards
--
--  · parent / sub      the Expense category and sub-category the card is
--                      linked to; its premiums are filed there
--  · term_months       how often it renews, in months (0 = no fixed term:
--                      the date is typed in afresh each time)
--  · due_mode          'fixed'    — due on the date set on the card (default)
--                      'payments' — due one term after the last payment filed
--                                   under its sub-category (a subscription
--                                   someone else pays, e.g. monthly via a chitty)
--  · reminders_off     no bell, pop-up, push or e-mail for this card; the card
--                      itself still shows ⚠ / ⛔
--
--  Adds columns only. Nothing is dropped, renamed or rewritten. Nullable on
--  purpose: a NOT NULL column that old rows hold as null locally fails the
--  whole row on the next sync (see healForPush in js/store.js).
--  Run in the Supabase SQL editor BEFORE uploading 2.1.
-- ============================================================================
alter table public.insurance
  add column if not exists parent        text,
  add column if not exists sub           text,
  add column if not exists term_months   integer default 12,
  add column if not exists due_mode      text    default 'fixed',
  add column if not exists reminders_off boolean default false;
