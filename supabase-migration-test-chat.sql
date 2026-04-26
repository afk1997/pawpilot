-- Test-chat harness migration.
-- Adds is_test flag to conversations + a "test_skipped" delivery_status value
-- on messages for outbound that was simulated rather than actually sent.
--
-- Apply once on the Supabase SQL editor (or via psql). Idempotent.

-- ---------------------------------------------------------------------------
-- conversations.is_test: marks a conversation as a local test-harness chat.
-- Filtered out of dispatcher dashboard, cron jobs, manual-send, etc.
-- Filtered IN by the /test-chat surface only.
-- ---------------------------------------------------------------------------
alter table conversations
  add column if not exists is_test boolean not null default false;

create index if not exists idx_conversations_is_test on conversations(is_test);

-- ---------------------------------------------------------------------------
-- messages.delivery_status: add 'test_skipped' so test-mode outbound is
-- distinguishable from real sent/failed without polluting those semantics.
-- ---------------------------------------------------------------------------
alter table messages drop constraint if exists messages_delivery_status_check;
alter table messages add constraint messages_delivery_status_check
  check (
    delivery_status is null
    or delivery_status in ('queued', 'sent', 'delivered', 'read', 'failed', 'test_skipped')
  );
