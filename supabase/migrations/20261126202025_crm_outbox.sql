-- CRM outbox: account events that trigger a transactional email and a HubSpot update.
-- Database triggers write events (sign-ups happen inside Supabase Auth, so only the database sees all of them);
-- the API drains the outbox every few minutes: upsert HubSpot contact → send email (Resend) → log it on the contact.
-- One row per (event_type, dedupe_key), so an event is emailed at most once. Service role only.

create table public.crm_outbox (
  id                 uuid primary key default gen_random_uuid(),
  event_type         text not null check (event_type in
                       ('owner_welcome', 'site_added', 'site_verified', 'connector_live', 'enterprise_lead')),
  dedupe_key         text not null check (char_length(dedupe_key) between 1 and 200),
  user_id            uuid references auth.users (id) on delete cascade,
  site_id            uuid references public.sites (id) on delete cascade,
  email              text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),  -- leads only; owners resolved from auth.users
  payload            jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 8192),
  status             text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts           int not null default 0 check (attempts >= 0),
  next_attempt_at    timestamptz not null default now(),
  last_error         text check (char_length(last_error) <= 500),
  hubspot_contact_id text,
  resend_email_id    text,
  hubspot_email_id   text,
  created_at         timestamptz not null default now(),
  processed_at       timestamptz,
  unique (event_type, dedupe_key),
  check (user_id is not null or email is not null)
);
create index crm_outbox_due_idx on public.crm_outbox (next_attempt_at) where status = 'pending';
create index crm_outbox_user_id_idx on public.crm_outbox (user_id);
create index crm_outbox_site_id_idx on public.crm_outbox (site_id);

-- Enqueue helper. Never raises: a CRM problem must not block a sign-up or a site change.
create or replace function public.aics_crm_enqueue(p_event text, p_key text, p_user uuid, p_site uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.crm_outbox (event_type, dedupe_key, user_id, site_id, payload)
  values (p_event, p_key, p_user, p_site, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_type, dedupe_key) do nothing;
exception when others then
  raise warning 'aics_crm_enqueue failed for % %: %', p_event, p_key, sqlerrm;
end;
$$;

-- Welcome once the email address is confirmed (not on raw sign-up, so unconfirmed or mistyped addresses get nothing).
create or replace function public.aics_crm_on_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is not null and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    perform public.aics_crm_enqueue('owner_welcome', new.id::text, new.id, null, '{}'::jsonb);
  end if;
  return new;
end;
$$;
create trigger aics_crm_user_confirmed after insert or update of email_confirmed_at on auth.users
  for each row execute function public.aics_crm_on_user();

create or replace function public.aics_crm_on_site()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.aics_crm_enqueue('site_added', new.id::text, new.owner_id, new.id, jsonb_build_object('domain', new.domain));
  elsif new.verified_at is not null and old.verified_at is null then
    perform public.aics_crm_enqueue('site_verified', new.id::text, new.owner_id, new.id, jsonb_build_object('domain', new.domain));
  end if;
  return new;
end;
$$;
create trigger aics_crm_site_events after insert or update of verified_at on public.sites
  for each row execute function public.aics_crm_on_site();

-- "Connector live": the first time any key of a site is used for a signed batch.
create or replace function public.aics_crm_on_key_used()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
begin
  if new.last_used_at is not null and old.last_used_at is null then
    select id, owner_id, domain into s from public.sites where id = new.site_id;
    if found then
      perform public.aics_crm_enqueue('connector_live', s.id::text, s.owner_id, s.id, jsonb_build_object('domain', s.domain));
    end if;
  end if;
  return new;
end;
$$;
create trigger aics_crm_connector_live after update of last_used_at on public.connector_keys
  for each row execute function public.aics_crm_on_key_used();

-- Claims due rows for the processor with a 10-minute lease (safe if two runs overlap), resolving the owner's
-- email and AICS lifecycle stage from the database at send time.
create or replace function public.aics_crm_claim(p_limit int default 25)
returns table (
  id uuid, event_type text, email text, payload jsonb, attempts int, site_domain text,
  hubspot_contact_id text, resend_email_id text, hubspot_email_id text,
  lifecycle_stage text, site_count int, signed_up_at timestamptz, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select o.id from public.crm_outbox o
    where o.status = 'pending' and o.next_attempt_at <= now()
    order by o.created_at
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  ), leased as (
    update public.crm_outbox o set next_attempt_at = now() + interval '10 minutes'
    from due where o.id = due.id
    returning o.*
  )
  select l.id, l.event_type, coalesce(l.email, u.email)::text, l.payload, l.attempts, st.domain,
         l.hubspot_contact_id, l.resend_email_id, l.hubspot_email_id,
         case
           when l.user_id is null then null
           when exists (select 1 from public.connector_keys k join public.sites s2 on s2.id = k.site_id
                        where s2.owner_id = l.user_id and k.last_used_at is not null) then 'connector_live'
           when exists (select 1 from public.sites s2 where s2.owner_id = l.user_id and s2.verified_at is not null) then 'site_verified'
           when exists (select 1 from public.sites s2 where s2.owner_id = l.user_id) then 'site_added'
           else 'signed_up'
         end,
         (select count(*)::int from public.sites s2 where s2.owner_id = l.user_id),
         u.email_confirmed_at,
         l.created_at
  from leased l
  left join auth.users u on u.id = l.user_id
  left join public.sites st on st.id = l.site_id;
end;
$$;

-- Sent rows are kept 90 days for support, then removed (they hold email addresses).
create or replace function public.aics_crm_prune(p_days int default 90)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.crm_outbox where status in ('sent', 'skipped', 'failed') and processed_at < now() - make_interval(days => p_days);
$$;

alter table public.crm_outbox enable row level security;
revoke all on public.crm_outbox from anon, authenticated;
grant select, insert, update on public.crm_outbox to service_role;

revoke all on function public.aics_crm_enqueue(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.aics_crm_on_user() from public, anon, authenticated;
revoke all on function public.aics_crm_on_site() from public, anon, authenticated;
revoke all on function public.aics_crm_on_key_used() from public, anon, authenticated;
revoke all on function public.aics_crm_claim(int) from public, anon, authenticated;
revoke all on function public.aics_crm_prune(int) from public, anon, authenticated;
grant execute on function public.aics_crm_claim(int) to service_role;
grant execute on function public.aics_crm_prune(int) to service_role;
