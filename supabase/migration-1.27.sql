-- ============================================================================
--  Jinnyfin 1.27 — archiving a category
--
--  Run this ONCE in Supabase → SQL Editor → New query → Run.
--  Safe to run twice; nothing is dropped and nothing is overwritten.
--
--  "Family Visit" was real for the year the family were here and is dead weight
--  in the dropdown ever since. Deleting it is wrong — the old entries still
--  carry the name and you may need it again — so it gets a switch instead.
--  Archived categories vanish from every picker and stay on every past
--  transaction, and one tick brings them back.
-- ============================================================================

alter table public.categories
  add column if not exists active boolean not null default true;

-- Everything that exists today stays visible.
update public.categories set active = true where active is null;

-- ---------------------------------------------------------- attachments ----
-- The invoice and the warranty card for a machine, kept with the record rather
-- than in a drawer at home. A list of {path, name, size, type, added}.
alter table public.insurance
  add column if not exists files jsonb not null default '[]'::jsonb;

-- A PRIVATE bucket. Nothing here is world-readable; the app hands out links
-- that expire after an hour, which is enough to show a service desk.
insert into storage.buckets (id, name, public, file_size_limit)
values ('docs', 'docs', false, 15728640)
on conflict (id) do nothing;

-- Each person can only reach files under a folder named with their own user id,
-- which is exactly how the app writes the path.
do $$ begin
  create policy "own docs read" on storage.objects for select to authenticated
    using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own docs write" on storage.objects for insert to authenticated
    with check (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own docs replace" on storage.objects for update to authenticated
    using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "own docs delete" on storage.objects for delete to authenticated
    using (bucket_id = 'docs' and (storage.foldername(name))[1] = auth.uid()::text);
exception when duplicate_object then null; end $$;

-- Tell PostgREST the shape of the database changed.
notify pgrst, 'reload schema';
