-- AICS v2: vendor billing. AI vendors with a signed agreement are invoiced monthly through Stripe for pages
-- fetched by their verified (tier 1-2) crawlers that sites allowed. Our rollups are the record of usage;
-- Stripe is the record of money. Everything here is service-role only (the API); no owner or anon access yet.

-- ───────────────────────── vendors ─────────────────────────
create table public.vendors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(name) between 1 and 120),
  match_vendor        text not null unique,          -- vendor label on crawler events, e.g. 'OpenAI'
  billing_email       text not null check (billing_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  stripe_customer_id  text unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  created_at          timestamptz not null default now()
);

-- ─────────────────────── agreements ───────────────────────
-- Versioned rates: changing a rate closes the current agreement and adds a new one; the past is never rewritten.
create table public.agreements (
  id                    uuid primary key default gen_random_uuid(),
  vendor_id             uuid not null references public.vendors (id) on delete restrict,
  rate_per_page_micros  bigint not null check (rate_per_page_micros > 0),  -- 10000 = $0.01 per page
  valid_from            date not null,
  valid_to              date,                                               -- exclusive; null = open-ended
  created_at            timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from)
);
create index agreements_vendor_id_idx on public.agreements (vendor_id, valid_from);

-- Overlapping agreements would bill the same page twice, so they are rejected.
create or replace function public.aics_agreements_no_overlap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.agreements a
    where a.vendor_id = new.vendor_id and a.id <> new.id
      and daterange(a.valid_from, a.valid_to, '[)') && daterange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'agreement overlaps an existing agreement for this vendor' using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;
create trigger agreements_no_overlap before insert or update on public.agreements
  for each row execute function public.aics_agreements_no_overlap();

-- ─────────────────────── invoices ───────────────────────
create table public.vendor_invoices (
  id                    uuid primary key default gen_random_uuid(),
  vendor_id             uuid not null references public.vendors (id) on delete restrict,
  period                text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- 'YYYY-MM' (UTC)
  pages                 bigint not null check (pages >= 0),
  amount_micros         bigint not null check (amount_micros >= 0),               -- pre-tax, before rounding
  stripe_invoice_id     text unique check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  status                text not null default 'pending'
                          check (status in ('pending', 'draft', 'open', 'paid', 'void', 'uncollectible')),
  amount_paid_cents     bigint check (amount_paid_cents >= 0),
  created_at            timestamptz not null default now(),
  sent_at               timestamptz,
  paid_at               timestamptz,
  unique (vendor_id, period)
);

-- What each site contributed to each invoice (the basis for owner payouts in v3).
create table public.vendor_invoice_sites (
  invoice_id            uuid not null references public.vendor_invoices (id) on delete cascade,
  site_id               uuid not null references public.sites (id) on delete restrict,
  rate_per_page_micros  bigint not null check (rate_per_page_micros > 0),
  pages                 bigint not null check (pages > 0),
  amount_micros         bigint not null check (amount_micros >= 0),
  primary key (invoice_id, site_id, rate_per_page_micros)
);
create index vendor_invoice_sites_site_id_idx on public.vendor_invoice_sites (site_id);

-- ─────────────────────── webhooks + ledger ───────────────────────
-- Stripe retries webhooks; an event id is processed once.
create table public.stripe_events (
  id           text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  type         text not null,
  received_at  timestamptz not null default now()
);

-- Insert-only money ledger. Balances are sums, never stored totals.
create table public.ledger_entries (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  entry_type    text not null check (entry_type in ('vendor_invoice_paid', 'vendor_invoice_refunded')),
  vendor_id     uuid not null references public.vendors (id) on delete restrict,
  invoice_id    uuid references public.vendor_invoices (id) on delete restrict,
  amount_cents  bigint not null,
  currency      text not null default 'usd' check (currency = 'usd'),
  stripe_ref    text not null,
  unique (entry_type, stripe_ref)
);
create index ledger_entries_vendor_id_idx on public.ledger_entries (vendor_id);
create index ledger_entries_invoice_id_idx on public.ledger_entries (invoice_id);

-- ─────────────────────── billable usage ───────────────────────
-- Licensed pages per vendor, site and rate for [p_start, p_end): verified crawlers (tier 1-2) that the site
-- allowed, from vendors with an agreement in force on that day.
create or replace function public.aics_billable_usage(p_start date, p_end date)
returns table (vendor_id uuid, site_id uuid, rate_per_page_micros bigint, pages bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, u.site_id, a.rate_per_page_micros, sum(u.pages)::bigint
  from public.daily_usage u
  join public.vendors v on v.match_vendor = u.vendor
  join public.agreements a
    on a.vendor_id = v.id and u.day >= a.valid_from and (a.valid_to is null or u.day < a.valid_to)
  where u.day >= p_start and u.day < p_end
    and u.tier in (1, 2) and u.action = 'allowed'
  group by v.id, u.site_id, a.rate_per_page_micros
  having sum(u.pages) > 0;
$$;

-- ─────────────────────── privileges ───────────────────────
alter table public.vendors              enable row level security;
alter table public.agreements           enable row level security;
alter table public.vendor_invoices      enable row level security;
alter table public.vendor_invoice_sites enable row level security;
alter table public.stripe_events        enable row level security;
alter table public.ledger_entries       enable row level security;

revoke all on public.vendors, public.agreements, public.vendor_invoices, public.vendor_invoice_sites,
  public.stripe_events, public.ledger_entries from anon, authenticated;
grant select, insert, update on public.vendors, public.agreements, public.vendor_invoices to service_role;
grant select, insert, delete on public.vendor_invoice_sites to service_role;
grant select, insert on public.stripe_events to service_role;
grant select, insert on public.ledger_entries to service_role;   -- no update/delete: the ledger is append-only

revoke all on function public.aics_billable_usage(date, date) from public, anon, authenticated;
grant execute on function public.aics_billable_usage(date, date) to service_role;
revoke all on function public.aics_agreements_no_overlap() from public, anon, authenticated;
