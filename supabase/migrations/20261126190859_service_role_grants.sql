-- The AICS API connects as service_role. Newer Supabase projects do not grant table privileges to the API
-- roles by default, so grant exactly what the API needs. service_role bypasses RLS, so this key stays server-side.
grant select, insert, update, delete on
  public.sites, public.connector_keys, public.vendor_ip_ranges,
  public.crawler_events, public.daily_usage, public.site_daily_views
to service_role;
