-- AICS v1 core schema: sites, connector keys, crawler events, rollups.
-- Access model:
--   * authenticated owners read their own sites and data through RLS;
--   * the AICS API uses the service role (bypasses RLS) for connector ingest and admin writes;
--   * anon has no access to anything.
-- Money is not in v1. Rates are stored as integer micro-dollars (1 = $0.000001).

-- Uses only core functions (gen_random_uuid is built in since Postgres 13); no extensions required.

-- Event partitions live in a private schema. Supabase grants anon/authenticated full access to every new
-- table in "public" by default, and PostgREST exposes "public"; partitions there would be readable directly,
-- bypassing the RLS on the parent table. Queries go through public.crawler_events, whose RLS applies.
create schema if not exists aics_partitions;
revoke all on schema aics_partitions from public, anon, authenticated;

-- ───────────────────────── sites ─────────────────────────
create table public.sites (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  domain                text not null,
  verify_token          text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  verified_at           timestamptz,
  mode                  text not null default 'block'
                          check (mode in ('block', 'meter-and-bill', 'allow')),
  rate_per_page_micros  bigint not null default 10000            -- $0.01
                          check (rate_per_page_micros > 0),
  created_at            timestamptz not null default now(),
  constraint sites_domain_format check (
    domain = lower(domain)
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  ),
  constraint sites_domain_unique unique (domain)
);
create index sites_owner_id_idx on public.sites (owner_id);

-- ───────────────────── connector keys ─────────────────────
-- No secret is stored. The API derives it as HMAC-SHA256(AICS_MASTER_KEY, id).
create table public.connector_keys (
  id          text primary key check (id ~ '^ck_[a-z0-9]{20}$'),
  site_id     uuid not null references public.sites (id) on delete cascade,
  label       text check (char_length(label) <= 80),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  last_used_at timestamptz
);
create index connector_keys_site_id_idx on public.connector_keys (site_id);

-- ─────────────────── vendor IP ranges ───────────────────
-- Published crawler IP ranges, refreshed by a platform cron job. Service role only.
create table public.vendor_ip_ranges (
  vendor      text not null,
  bot         text not null,
  cidr        cidr not null,
  source_url  text not null,
  fetched_at  timestamptz not null default now(),
  primary key (bot, cidr)
);

-- ─────────────────── crawler events ───────────────────
-- Partitioned by month on ts so retention is a cheap partition drop (13 months).
-- Idempotency: a retried batch resends the same (site_id, event_id, ts) and is ignored.
create table public.crawler_events (
  site_id      uuid not null references public.sites (id) on delete cascade,
  event_id     text not null check (event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  ts           timestamptz not null,
  received_at  timestamptz not null default now(),
  batch_id     uuid not null,
  bot          text not null,
  vendor       text not null,
  tier         smallint not null check (tier between 1 and 3),  -- 1 key, 2 verified network, 3 UA only
  action       text not null check (action in ('blocked', 'allowed')),
  ip           inet not null,
  user_agent   text not null check (char_length(user_agent) <= 512),
  path         text not null check (char_length(path) <= 2048),
  bytes        bigint not null check (bytes >= 0),
  tokens_est   bigint not null check (tokens_est >= 0),
  primary key (site_id, event_id, ts)
) partition by range (ts);

create index crawler_events_site_ts_idx on public.crawler_events (site_id, ts desc);

create table aics_partitions.crawler_events_default partition of public.crawler_events default;

-- Creates monthly partitions from last month through `months_ahead` months ahead. Safe to rerun.
create or replace function public.aics_ensure_event_partitions(months_ahead int default 3)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m date;
  part text;
begin
  for i in -1..months_ahead loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    part := format('crawler_events_%s', to_char(m, 'YYYY_MM'));
    if to_regclass('aics_partitions.' || part) is null then
      execute format(
        'create table aics_partitions.%I partition of public.crawler_events for values from (%L) to (%L)',
        part, m, (m + interval '1 month')::date
      );
    end if;
  end loop;
end;
$$;

-- Drops monthly partitions older than `keep_months`. Raw events are kept 13 months.
create or replace function public.aics_drop_old_event_partitions(keep_months int default 13)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  cutoff date := (date_trunc('month', now()) - make_interval(months => keep_months))::date;
begin
  for r in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_namespace n on n.oid = c.relnamespace
    where i.inhparent = 'public.crawler_events'::regclass
      and n.nspname = 'aics_partitions' and c.relname ~ '^crawler_events_\d{4}_\d{2}$'
  loop
    if to_date(substring(r.relname from '\d{4}_\d{2}$'), 'YYYY_MM') < cutoff then
      execute format('drop table aics_partitions.%I', r.relname);
    end if;
  end loop;
end;
$$;

select public.aics_ensure_event_partitions(3);

-- ─────────────────── daily rollups ───────────────────
create table public.daily_usage (
  site_id     uuid not null references public.sites (id) on delete cascade,
  day         date not null,
  vendor      text not null,
  tier        smallint not null check (tier between 1 and 3),
  action      text not null check (action in ('blocked', 'allowed')),
  pages       bigint not null default 0 check (pages >= 0),
  tokens_est  bigint not null default 0 check (tokens_est >= 0),
  primary key (site_id, day, vendor, tier, action)
);

-- Anonymous human page-view count only (no IPs, no user agents).
create table public.site_daily_views (
  site_id      uuid not null references public.sites (id) on delete cascade,
  day          date not null,
  human_views  bigint not null default 0 check (human_views >= 0),
  primary key (site_id, day)
);

-- Recomputes daily_usage for one UTC day from raw events. Idempotent.
create or replace function public.aics_rollup_day(target_day date)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.daily_usage where day = target_day;
  insert into public.daily_usage (site_id, day, vendor, tier, action, pages, tokens_est)
  select site_id, target_day, vendor, tier, action, count(*), sum(tokens_est)
  from public.crawler_events
  where ts >= (target_day::timestamp at time zone 'UTC')
    and ts <  ((target_day + 1)::timestamp at time zone 'UTC')
  group by site_id, vendor, tier, action;
$$;

-- Maintenance functions are for the service role / pg_cron only.
revoke all on function public.aics_ensure_event_partitions(int) from public, anon, authenticated;
revoke all on function public.aics_drop_old_event_partitions(int) from public, anon, authenticated;
revoke all on function public.aics_rollup_day(date) from public, anon, authenticated;
grant execute on function public.aics_ensure_event_partitions(int) to service_role;
grant execute on function public.aics_drop_old_event_partitions(int) to service_role;
grant execute on function public.aics_rollup_day(date) to service_role;

-- ─────────────────── row-level security ───────────────────
alter table public.sites            enable row level security;
alter table public.connector_keys   enable row level security;
alter table public.vendor_ip_ranges enable row level security;
alter table public.crawler_events   enable row level security;
alter table public.daily_usage      enable row level security;
alter table public.site_daily_views enable row level security;

-- Table privileges: owners read; the only owner writes are creating a site and changing mode/rate.
-- Domain verification, keys and events are written by the API with the service role.
revoke all on public.sites, public.connector_keys, public.vendor_ip_ranges,
  public.crawler_events, public.daily_usage, public.site_daily_views from anon, authenticated;
grant select on public.sites, public.connector_keys, public.crawler_events,
  public.daily_usage, public.site_daily_views to authenticated;
grant insert (domain) on public.sites to authenticated;
grant update (mode, rate_per_page_micros) on public.sites to authenticated;
grant delete on public.sites to authenticated;

create policy sites_owner_select on public.sites
  for select to authenticated using (owner_id = (select auth.uid()));
create policy sites_owner_insert on public.sites
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy sites_owner_update on public.sites
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy sites_owner_delete on public.sites
  for delete to authenticated using (owner_id = (select auth.uid()));

-- owner_id defaults to the caller, so the client never chooses it.
alter table public.sites alter column owner_id set default auth.uid();

create policy connector_keys_owner_select on public.connector_keys
  for select to authenticated using (
    site_id in (select id from public.sites where owner_id = (select auth.uid()))
  );
create policy crawler_events_owner_select on public.crawler_events
  for select to authenticated using (
    site_id in (select id from public.sites where owner_id = (select auth.uid()))
  );
create policy daily_usage_owner_select on public.daily_usage
  for select to authenticated using (
    site_id in (select id from public.sites where owner_id = (select auth.uid()))
  );
create policy site_daily_views_owner_select on public.site_daily_views
  for select to authenticated using (
    site_id in (select id from public.sites where owner_id = (select auth.uid()))
  );
-- vendor_ip_ranges: RLS on with no policies, so only the service role can read or write it.
