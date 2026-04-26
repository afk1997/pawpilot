-- V1.2: per-conversation advisory lock RPCs.
-- Run this in Supabase SQL Editor once.
--
-- We use pg_advisory_lock (session-scoped, reentrant). Supabase clients
-- run each RPC in its own session, so the lock and unlock calls must
-- happen on the same connection. The Supabase REST API uses transaction
-- pooling, which preserves the connection per-request — adequate for our
-- async sequential pattern (acquire, run, release inside one server-side
-- function call chain).

create or replace function acquire_conversation_lock(lock_key bigint)
returns void
language plpgsql
security definer
as $$
begin
  perform pg_advisory_lock(lock_key);
end;
$$;

create or replace function release_conversation_lock(lock_key bigint)
returns boolean
language plpgsql
security definer
as $$
begin
  return pg_advisory_unlock(lock_key);
end;
$$;

-- Allow the service role to call these RPCs.
grant execute on function acquire_conversation_lock(bigint) to service_role;
grant execute on function release_conversation_lock(bigint) to service_role;
