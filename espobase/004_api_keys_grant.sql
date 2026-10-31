-- Fix: let signed-in users create, list and revoke their own API keys.
-- (Row level security still limits each user to their own keys.)
grant select, insert, update, delete on public.api_keys to espobase_project_em28cq3dw9_authenticated;
