-- Cache table for analyze_base_token_safety results (TTL enforced by the reader: updated_at > now() - 300s).
create table if not exists public.token_risk_cache (
  token_address  text primary key check (token_address ~ '^0x[0-9a-f]{40}$'),
  payload        jsonb       not null,
  risk_score     smallint    not null check (risk_score between 0 and 100),
  status         text        not null check (status in ('SAFE', 'WARN', 'DANGER')),
  confidence     real,
  block_number   bigint,
  engine_version text,
  updated_at     timestamptz not null default now()
);

-- Freshness scans / cleanup jobs.
create index if not exists token_risk_cache_updated_at_idx on public.token_risk_cache (updated_at desc);
-- Dashboards: "show me every DANGER token checked recently".
create index if not exists token_risk_cache_status_updated_idx on public.token_risk_cache (status, updated_at desc);

-- Only the service role (server-side) touches this table. No anon/authenticated policies are created,
-- so with RLS enabled the public API keys cannot read or write it.
alter table public.token_risk_cache enable row level security;

-- Optional housekeeping: drop rows older than a day (run via pg_cron or a scheduled job).
-- delete from public.token_risk_cache where updated_at < now() - interval '1 day';
