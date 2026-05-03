-- AlwaysCare Answer Engine — additive KB governance schema.
-- Safe to run against an existing project. It does not drop or rename
-- production dispatcher tables.

create extension if not exists pg_trgm;

create table if not exists kb_sources (
  id uuid default gen_random_uuid() primary key,
  source_key text not null unique,
  name text not null,
  source_type text not null default 'workbook',
  description text,
  created_at timestamp with time zone default now()
);

create table if not exists kb_source_versions (
  id uuid default gen_random_uuid() primary key,
  source_id uuid references kb_sources(id) on delete cascade not null,
  file_name text not null,
  file_sha256 text not null,
  validation_report jsonb not null default '{}'::jsonb,
  parsed_summary jsonb not null default '{}'::jsonb,
  imported_at timestamp with time zone default now(),
  published_at timestamp with time zone,
  unique (source_id, file_sha256)
);

create table if not exists kb_publish_batches (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete cascade not null,
  status text not null default 'started' check (status in ('started', 'published', 'failed')),
  summary jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamp with time zone default now(),
  finished_at timestamp with time zone
);

create table if not exists kb_staged_records (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete cascade not null,
  record_type text not null,
  natural_key text not null,
  payload jsonb not null,
  created_at timestamp with time zone default now(),
  unique (source_version_id, record_type, natural_key)
);
create index if not exists idx_kb_staged_records_version_type
  on kb_staged_records(source_version_id, record_type);

create table if not exists kb_articles (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  article_key text not null unique,
  category text not null,
  title text not null,
  body text not null,
  language text not null default 'en',
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) stored,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_kb_articles_category on kb_articles(category) where active;
create index if not exists idx_kb_articles_search on kb_articles using gin(search_vector);
create index if not exists idx_kb_articles_trgm on kb_articles using gin((title || ' ' || body) gin_trgm_ops);

create table if not exists kb_article_chunks (
  id uuid default gen_random_uuid() primary key,
  article_id uuid references kb_articles(id) on delete cascade not null,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  article_key text not null,
  chunk_index integer not null,
  content text not null,
  embedding_json jsonb,
  source_sheet text,
  source_row integer,
  search_vector tsvector generated always as (to_tsvector('english', coalesce(content, ''))) stored,
  created_at timestamp with time zone default now(),
  unique (article_id, chunk_index)
);
create index if not exists idx_kb_article_chunks_article on kb_article_chunks(article_id);
create index if not exists idx_kb_article_chunks_search on kb_article_chunks using gin(search_vector);
create index if not exists idx_kb_article_chunks_trgm on kb_article_chunks using gin(content gin_trgm_ops);

create table if not exists kb_facts (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  fact_key text not null unique,
  category text not null,
  label text not null,
  value text not null,
  value_type text not null default 'text',
  language text not null default 'en',
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_kb_facts_category on kb_facts(category) where active;
create index if not exists idx_kb_facts_trgm on kb_facts using gin((label || ' ' || value) gin_trgm_ops);

create table if not exists official_links (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  link_key text not null unique,
  label text not null,
  url text not null,
  notes text,
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_official_links_key on official_links(link_key) where active;

create table if not exists coverage_areas (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  coverage_key text not null unique,
  city text not null,
  area text,
  state text not null,
  status text not null default 'active' check (status in ('active', 'launching_soon', 'unknown')),
  aliases text[] not null default '{}',
  notes text,
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_coverage_areas_city on coverage_areas(city) where active;
create index if not exists idx_coverage_areas_status on coverage_areas(status) where active;
create index if not exists idx_coverage_areas_aliases on coverage_areas using gin(aliases) where active;
create index if not exists idx_coverage_areas_trgm on coverage_areas using gin((city || ' ' || coalesce(area, '')) gin_trgm_ops);

create table if not exists response_templates (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  template_key text not null unique,
  scenario text not null,
  intent text,
  language text not null default 'en',
  template text not null,
  safe boolean not null default true,
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);
create index if not exists idx_response_templates_intent on response_templates(intent) where active and safe;

create table if not exists escalation_rules (
  id uuid default gen_random_uuid() primary key,
  source_version_id uuid references kb_source_versions(id) on delete set null,
  rule_key text not null unique,
  trigger text not null,
  action text not null,
  route_to text,
  active boolean not null default true,
  source_sheet text,
  source_row integer,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create table if not exists answer_events (
  id uuid default gen_random_uuid() primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  inbound_message_id uuid references messages(id) on delete set null,
  outbound_message_id uuid references messages(id) on delete set null,
  intent text not null,
  language text,
  confidence text,
  evidence jsonb not null default '{}'::jsonb,
  validation jsonb not null default '{}'::jsonb,
  answer_text text,
  delivery_status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default now()
);
create index if not exists idx_answer_events_conversation on answer_events(conversation_id, created_at desc);
create index if not exists idx_answer_events_intent_time on answer_events(intent, created_at desc);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'answer_events'
    )
  then
    alter publication supabase_realtime add table answer_events;
  end if;
end $$;
