-- Arham Always Care WhatsApp dispatch agent — database schema.
-- Run this in Supabase SQL Editor to set up a fresh database, or use
-- supabase-migration.sql for incremental changes against an existing DB.
--
-- Tables:
--   ngo_operators       — Arham itself + each partner NGO that operates ambulances
--   ambulances          — directory of all 45+ animal ambulances (loaded from CSV)
--   clinics             — directory of Arham-operated clinics
--   conversations       — one row per reporter phone number; carries status + claim info
--   messages            — one row per WhatsApp message (in or out)
--   agent_actions       — audit log of every agent decision, tool call, dispatcher action

-- ---------------------------------------------------------------------------
-- ngo_operators: Arham itself + each partner NGO that operates ambulances.
-- ---------------------------------------------------------------------------
create table ngo_operators (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  is_arham boolean not null default false,        -- true for Arham Yuva Seva Group itself
  ops_contact_name text,
  ops_contact_phone text,
  notes text,
  active boolean not null default true,
  created_at timestamp with time zone default now()
);

-- ---------------------------------------------------------------------------
-- ambulances: each ambulance is operated by one NGO (Arham or a partner).
-- ---------------------------------------------------------------------------
create table ambulances (
  id uuid default gen_random_uuid() primary key,
  operator_id uuid references ngo_operators(id) not null,
  label text not null,                             -- "Mumbai - Ghatkopar" etc., from CSV "Name" column
  city text not null,
  area text,                                       -- specific area within city, may be null
  state text not null,
  phone text not null,                             -- E.164 normalized: +91XXXXXXXXXX
  phone_raw text,                                  -- original from CSV for reference
  areas_covered text[] not null default '{}',      -- list of suburbs/areas this unit covers
  category text not null default 'Animal Ambulance',  -- "Animal Ambulance", "Hydraulic Ambulance", "Rescue Ambulance"
  active boolean not null default true,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index idx_ambulances_city on ambulances(city) where active;
create index idx_ambulances_state on ambulances(state) where active;
create index idx_ambulances_operator on ambulances(operator_id);
create index idx_ambulances_areas_gin on ambulances using gin(areas_covered) where active;

-- ---------------------------------------------------------------------------
-- clinics: Arham-operated clinics (5 of them at last count).
-- ---------------------------------------------------------------------------
create table clinics (
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
create index idx_clinics_city on clinics(city) where active;

-- ---------------------------------------------------------------------------
-- conversations: extends prototype's conversations table with dispatch state.
-- ---------------------------------------------------------------------------
create table conversations (
  id uuid default gen_random_uuid() primary key,
  phone text unique not null,
  name text,
  mode text not null default 'agent' check (mode in ('agent', 'human')),
  status text not null default 'new' check (status in (
    'new',                  -- never replied to
    'awaiting_location',    -- agent has asked, no usable location yet
    'number_delivered',     -- agent gave the driver phone; awaiting reporter action
    'awaiting_followup',    -- 5-min followup sent, waiting on yes/no
    'escalated',            -- red badge, dispatcher must act
    'out_of_coverage',      -- city not in directory
    'closed'                -- case closed (closure summary sent or dispatcher closed)
  )),
  intent text check (intent in ('emergency', 'donate', 'volunteer', 'clinic_info', 'faq', 'other')),
  language text,                                   -- 'en' | 'hi' | 'mr' | 'gu' | etc.
  delivered_ambulance_id uuid references ambulances(id),
  delivered_at timestamp with time zone,
  awaiting_followup_at timestamp with time zone,   -- when to send the "did you connect?" ping
  escalation_reason text,
  claimed_by text,                                 -- dispatcher email/id who has the conversation open
  claimed_at timestamp with time zone,
  last_inbound_at timestamp with time zone,        -- for 24h-window template logic
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index idx_conversations_updated on conversations(updated_at desc);
create index idx_conversations_status on conversations(status);
create index idx_conversations_followup on conversations(awaiting_followup_at)
  where awaiting_followup_at is not null and status = 'number_delivered';
create index idx_conversations_closure_poll on conversations(delivered_at)
  where delivered_at is not null and status not in ('closed', 'escalated');

-- ---------------------------------------------------------------------------
-- messages: one row per WhatsApp message in or out.
-- ---------------------------------------------------------------------------
create table messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  whatsapp_msg_id text unique,                     -- Interakt message id, dedup key
  message_type text not null default 'text' check (message_type in (
    'text', 'image', 'video', 'audio', 'document', 'location', 'sticker', 'contact', 'template'
  )),
  media_url text,                                  -- Interakt-hosted media URL
  media_caption text,
  location_lat double precision,
  location_lng double precision,
  is_instant_ack boolean not null default false,   -- true for the <1s acknowledgment
  is_template boolean not null default false,      -- true if outbound used pre-approved template
  template_name text,
  delivery_status text check (delivery_status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  failed_reason text,
  created_at timestamp with time zone default now()
);
create index idx_messages_conversation on messages(conversation_id, created_at);
create index idx_messages_unread on messages(conversation_id) where role = 'user' and delivery_status is null;

-- ---------------------------------------------------------------------------
-- agent_actions: audit log of every agent decision and dispatcher action.
-- This is the ground truth for incident investigations.
-- ---------------------------------------------------------------------------
create table agent_actions (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade not null,
  message_id uuid references messages(id) on delete set null,
  action_type text not null check (action_type in (
    'inbound',                    -- reporter sent a message
    'instant_ack',                -- <1s pre-LLM acknowledgment
    'tool_call',                  -- LLM invoked a tool
    'outbound',                   -- agent sent a message
    'escalation',                 -- auto-escalated (any reason)
    'dispatcher_takeover',        -- human clicked "Take Over"
    'dispatcher_release',         -- human released conversation back to agent
    'dispatcher_send',            -- human typed a message
    'status_change',              -- conversation.status changed
    'followup_sent',              -- 5-min cron sent the "did you connect?" ping
    'closure_sent',               -- closure summary fired
    'degraded'                    -- a subsystem failed; degraded mode entered
  )),
  tool_name text,                 -- find_ambulance_by_area, etc.
  tool_input jsonb,
  tool_output jsonb,
  message_text text,              -- snapshot of the message body for audit
  metadata jsonb,                 -- escalation reason, status_change details, etc.
  actor text,                     -- 'agent' | dispatcher email
  created_at timestamp with time zone default now()
);
create index idx_agent_actions_conversation on agent_actions(conversation_id, created_at);
create index idx_agent_actions_type_time on agent_actions(action_type, created_at desc);

-- ---------------------------------------------------------------------------
-- Realtime publication: dashboard subscribes to these to update live.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table agent_actions;
