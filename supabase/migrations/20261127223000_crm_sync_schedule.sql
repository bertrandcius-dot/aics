-- Runs the crm-sync edge function every 5 minutes (pg_cron + pg_net).
--
-- Authentication without a stored service-role key: a random secret is generated inside Vault (no human or
-- file ever sees it). The cron job sends it in the x-aics-cron header; crm-sync checks it by calling
-- aics_crm_check_cron_secret() with its own service-role connection. The Authorization header carries the
-- project's public anon key, only to pass the functions gateway's JWT check.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'aics_crm_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'aics_crm_cron_secret',
      'Shared secret between pg_cron and the crm-sync edge function');
  end if;
end;
$$;

create or replace function public.aics_crm_check_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_secret is not null and length(p_secret) = 64 and exists (
    select 1 from vault.decrypted_secrets where name = 'aics_crm_cron_secret' and decrypted_secret = p_secret
  ), false);
$$;
revoke all on function public.aics_crm_check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.aics_crm_check_cron_secret(text) to service_role;

-- Re-create the job idempotently.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'aics-crm-sync') then
    perform cron.unschedule('aics-crm-sync');
  end if;
  if exists (select 1 from cron.job where jobname = 'aics-crm-prune') then
    perform cron.unschedule('aics-crm-prune');
  end if;
end;
$$;

select cron.schedule('aics-crm-sync', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://bsabcachyqtxobocgeiu.supabase.co/functions/v1/crm-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJzYWJjYWNoeXF0eG9ib2NnZWl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU3MTcxNDQsImV4cCI6MjExMTI5MzE0NH0.Dz7Kz3szxUTNB0D3TMCu2hH7_I7AjdMAxnFZozA-VvQ',
      'x-aics-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'aics_crm_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$job$);

-- Daily cleanup of processed outbox rows older than 90 days (they hold email addresses).
select cron.schedule('aics-crm-prune', '17 4 * * *', $job$ select public.aics_crm_prune(90); $job$);
