-- Incremental migration to apply on top of an existing prototype DB
-- (the dental-clinic version). Idempotent — safe to re-run.
--
-- If your DB is empty, use supabase-schema.sql instead.

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------
create table if not exists ngo_operators (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  is_arham boolean not null default false,
  ops_contact_name text,
  ops_contact_phone text,
  notes text,
  active boolean not null default true,
  created_at timestamp with time zone default now()
);

create table if not exists ambulances (
  id uuid default gen_random_uuid() primary key,
  operator_id uuid references ngo_operators(id) not null,
  label text not null,
  city text not null,
  area text,
  state text not null,
  phone text not null,
  phone_raw text,
  areas_covered text[] not null default '{}',
  category text not null default 'Animal Ambulance',
  active boolean not null default true,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_ambulances_city on ambulances(city) where active;
create index if not exists idx_ambulances_state on ambulances(state) where active;
create index if not exists idx_ambulances_operator on ambulances(operator_id);
create index if not exists idx_ambulances_areas_gin on ambulances using gin(areas_covered) where active;

create table if not exists clinics (
  id uuid default gen_random_uuid() primary key,
  operator_id uuid references ngo_operators(id) not null,
  label text not null,
  city text not null,
  area text,
  state text not null,
  phone text not null,
  phone_raw text,
  address text,
  hours text,
  active boolean not null default true,
  created_at timestamp with time zone default now()
);
create index if not exists idx_clinics_city on clinics(city) where active;

create table if not exists agent_actions (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade not null,
  message_id uuid,
  action_type text not null,
  tool_name text,
  tool_input jsonb,
  tool_output jsonb,
  message_text text,
  metadata jsonb,
  actor text,
  created_at timestamp with time zone default now()
);
create index if not exists idx_agent_actions_conversation on agent_actions(conversation_id, created_at);
create index if not exists idx_agent_actions_type_time on agent_actions(action_type, created_at desc);

-- agent_actions.message_id reference, only after messages exists with right shape
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'agent_actions_message_id_fkey'
  ) then
    alter table agent_actions
      add constraint agent_actions_message_id_fkey
      foreign key (message_id) references messages(id) on delete set null;
  end if;
end$$;

-- agent_actions.action_type check (drop first if shape changed)
alter table agent_actions drop constraint if exists agent_actions_action_type_check;
alter table agent_actions add constraint agent_actions_action_type_check
  check (action_type in (
    'inbound', 'instant_ack', 'tool_call', 'outbound', 'escalation',
    'dispatcher_takeover', 'dispatcher_release', 'dispatcher_send',
    'status_change', 'followup_sent', 'closure_sent', 'degraded'
  ));

-- ---------------------------------------------------------------------------
-- conversations: new columns
-- ---------------------------------------------------------------------------
alter table conversations add column if not exists status text not null default 'new';
alter table conversations drop constraint if exists conversations_status_check;
alter table conversations add constraint conversations_status_check
  check (status in (
    'new', 'awaiting_location', 'number_delivered', 'awaiting_followup',
    'escalated', 'out_of_coverage', 'closed'
  ));

alter table conversations add column if not exists intent text;
alter table conversations drop constraint if exists conversations_intent_check;
alter table conversations add constraint conversations_intent_check
  check (intent is null or intent in ('emergency', 'donate', 'volunteer', 'clinic_info', 'faq', 'other'));

alter table conversations add column if not exists language text;
alter table conversations add column if not exists delivered_ambulance_id uuid;
alter table conversations add column if not exists delivered_at timestamp with time zone;
alter table conversations add column if not exists awaiting_followup_at timestamp with time zone;
alter table conversations add column if not exists escalation_reason text;
alter table conversations add column if not exists claimed_by text;
alter table conversations add column if not exists claimed_at timestamp with time zone;
alter table conversations add column if not exists last_inbound_at timestamp with time zone;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'conversations_delivered_ambulance_fkey'
  ) then
    alter table conversations
      add constraint conversations_delivered_ambulance_fkey
      foreign key (delivered_ambulance_id) references ambulances(id);
  end if;
end$$;

create index if not exists idx_conversations_status on conversations(status);
create index if not exists idx_conversations_followup on conversations(awaiting_followup_at)
  where awaiting_followup_at is not null and status = 'number_delivered';
create index if not exists idx_conversations_closure_poll on conversations(delivered_at)
  where delivered_at is not null and status not in ('closed', 'escalated');

-- ---------------------------------------------------------------------------
-- messages: new columns for multimedia + delivery status
-- ---------------------------------------------------------------------------
alter table messages add column if not exists message_type text not null default 'text';
alter table messages drop constraint if exists messages_message_type_check;
alter table messages add constraint messages_message_type_check
  check (message_type in (
    'text', 'image', 'video', 'audio', 'document', 'location', 'sticker', 'contact', 'template'
  ));

alter table messages add column if not exists media_url text;
alter table messages add column if not exists media_caption text;
alter table messages add column if not exists location_lat double precision;
alter table messages add column if not exists location_lng double precision;
alter table messages add column if not exists is_instant_ack boolean not null default false;
alter table messages add column if not exists is_template boolean not null default false;
alter table messages add column if not exists template_name text;
alter table messages add column if not exists delivery_status text;
alter table messages drop constraint if exists messages_delivery_status_check;
alter table messages add constraint messages_delivery_status_check
  check (delivery_status is null or delivery_status in ('queued', 'sent', 'delivered', 'read', 'failed'));
alter table messages add column if not exists failed_reason text;

create index if not exists idx_messages_unread on messages(conversation_id)
  where role = 'user' and delivery_status is null;

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------
do $$
begin
  perform 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'agent_actions';
  if not found then
    alter publication supabase_realtime add table agent_actions;
  end if;
end$$;
