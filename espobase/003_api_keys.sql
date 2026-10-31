-- Editums public API keys.
-- The key itself is never stored: only its SHA-256 fingerprint (key_hash) and a short prefix for display.
-- The publishing server looks keys up by key_hash using the Espobase secret key.

create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default espobase.user_id(),
  name          text not null check (char_length(name) between 1 and 60),
  prefix        text not null check (char_length(prefix) <= 20),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;

drop policy if exists api_keys_read_own on public.api_keys;
create policy api_keys_read_own on public.api_keys
  for select using (user_id = espobase.user_id());

drop policy if exists api_keys_insert_own on public.api_keys;
create policy api_keys_insert_own on public.api_keys
  for insert with check (user_id = espobase.user_id() and revoked_at is null and last_used_at is null);

drop policy if exists api_keys_revoke_own on public.api_keys;
create policy api_keys_revoke_own on public.api_keys
  for update using (user_id = espobase.user_id()) with check (user_id = espobase.user_id());

drop policy if exists api_keys_delete_own on public.api_keys;
create policy api_keys_delete_own on public.api_keys
  for delete using (user_id = espobase.user_id());

-- At most 25 active keys per user.
create or replace function public.api_keys_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.api_keys where user_id = new.user_id and revoked_at is null) >= 25 then
    raise exception 'You can have at most 25 active API keys. Revoke one first.';
  end if;
  return new;
end $$;

drop trigger if exists api_keys_limit on public.api_keys;
create trigger api_keys_limit before insert on public.api_keys
  for each row execute function public.api_keys_limit();
