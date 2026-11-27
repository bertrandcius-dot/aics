// ⊗ AICS — CRM outbox processor (Supabase Edge Function "crm-sync").
//
// Drains public.crm_outbox (filled by database triggers on sign-up confirmation, new site, site verified,
// connector live) and syncs each event to HubSpot:
//   1. upsert the HubSpot contact by email (website = the site's domain)
//   2. log the event as a note on that contact
//   3. optionally send a transactional email through Resend (only if RESEND_API_KEY is set)
// Each step's id is stored on the row, so a retry never repeats a step that already succeeded.
//
// Call it with the service-role key (pg_cron + pg_net, or a scheduler):
//   POST https://<project>.supabase.co/functions/v1/crm-sync   Authorization: Bearer <service role key>
//
// Secrets (supabase secrets set ...):
//   HUBSPOT_ACCESS_TOKEN  HubSpot private-app token with crm.objects.contacts.write  (required)
//   RESEND_API_KEY        optional; welcome/lifecycle emails are skipped without it
//   CRM_FROM_EMAIL        optional; sender for Resend, e.g. "AICS <hello@yourdomain.com>"
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
import { createClient } from "jsr:@supabase/supabase-js@2";

const HUBSPOT = "https://api.hubapi.com";
const MAX_ATTEMPTS = 8;

type Row = {
  id: string; event_type: string; email: string | null; payload: Record<string, unknown>; attempts: number;
  site_domain: string | null; hubspot_contact_id: string | null; resend_email_id: string | null;
  hubspot_email_id: string | null; lifecycle_stage: string | null; site_count: number | null;
  signed_up_at: string | null; created_at: string;
};

const SUBJECT: Record<string, string> = {
  owner_welcome: "Welcome to AI Copyright Shield",
  site_added: "Your domain is registered with AICS",
  site_verified: "Your domain is verified",
  connector_live: "AICS is now protecting your site",
  enterprise_lead: "We received your AICS enterprise request",
};

function noteBody(r: Row): string {
  const what: Record<string, string> = {
    owner_welcome: "Confirmed their AICS account",
    site_added: `Registered ${r.site_domain ?? "a domain"}`,
    site_verified: `Verified ${r.site_domain ?? "a domain"}`,
    connector_live: `Connector went live on ${r.site_domain ?? "a domain"}`,
    enterprise_lead: "Sent an enterprise request",
  };
  return `AICS: ${what[r.event_type] ?? r.event_type}. Stage: ${r.lifecycle_stage ?? "lead"}; sites: ${r.site_count ?? 0}.`;
}

/** The gateway verifies the JWT signature (verify_jwt = true); we additionally require the service role. */
function isServiceRole(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return true;
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return claims.role === "service_role";
  } catch { return false; }
}

async function hubspot(path: string, body: unknown, token: string) {
  const res = await fetch(HUBSPOT + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function upsertContact(r: Row, token: string): Promise<string> {
  const properties: Record<string, string> = { email: r.email! };
  if (r.site_domain) properties.website = r.site_domain;
  const out = await hubspot("/crm/v3/objects/contacts/batch/upsert",
    { inputs: [{ idProperty: "email", id: r.email, properties }] }, token);
  const id = out?.results?.[0]?.id;
  if (!id) throw new Error("HubSpot upsert returned no contact id");
  return String(id);
}

async function logNote(r: Row, contactId: string, token: string): Promise<string> {
  const out = await hubspot("/crm/v3/objects/notes", {
    properties: { hs_timestamp: new Date(r.created_at).toISOString(), hs_note_body: noteBody(r) },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
  }, token);
  return String(out.id);
}

async function sendEmail(r: Row, key: string, from: string): Promise<string> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `aics-${r.id}` },
    body: JSON.stringify({
      from, to: [r.email], subject: SUBJECT[r.event_type] ?? "AICS update",
      text: `${noteBody(r).replace(/^AICS: /, "")}\n\nOpen your dashboard to see crawler activity and manage licences.`,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(out).slice(0, 200)}`);
  return String(out.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Allowed callers: the service role, or the pg_cron job presenting the Vault-held secret.
  let allowed = isServiceRole(req);
  const cronSecret = req.headers.get("x-aics-cron");
  if (!allowed && cronSecret) {
    const { data } = await db.rpc("aics_crm_check_cron_secret", { p_secret: cronSecret });
    allowed = data === true;
  }
  if (!allowed) return new Response("forbidden", { status: 403 });

  const token = Deno.env.get("HUBSPOT_ACCESS_TOKEN");
  // Without a token, leave the queue untouched (rows stay pending) until the secret is set.
  if (!token) return Response.json({ error: "HUBSPOT_ACCESS_TOKEN is not set" }, { status: 503 });
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("CRM_FROM_EMAIL") ?? "AICS <onboarding@resend.dev>";

  const { data: rows, error } = await db.rpc("aics_crm_claim", { p_limit: 25 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const summary = { claimed: rows?.length ?? 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (const r of (rows ?? []) as Row[]) {
    const patch: Record<string, unknown> = {};
    try {
      if (!r.email) {
        await db.from("crm_outbox").update({ status: "skipped", last_error: "no email", processed_at: new Date().toISOString() }).eq("id", r.id);
        summary.skipped++; continue;
      }
      const contactId = r.hubspot_contact_id ?? await upsertContact(r, token);
      patch.hubspot_contact_id = contactId;
      if (!r.hubspot_email_id) patch.hubspot_email_id = await logNote(r, contactId, token);
      if (resendKey && !r.resend_email_id) patch.resend_email_id = await sendEmail(r, resendKey, from);
      await db.from("crm_outbox").update({ ...patch, status: "sent", last_error: null, processed_at: new Date().toISOString() }).eq("id", r.id);
      summary.sent++;
    } catch (e) {
      const attempts = r.attempts + 1;
      const done = attempts >= MAX_ATTEMPTS;
      const backoffMin = Math.min(2 ** attempts, 360);
      await db.from("crm_outbox").update({
        ...patch, attempts, status: done ? "failed" : "pending",
        last_error: String((e as Error).message ?? e).slice(0, 500),
        next_attempt_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
        processed_at: done ? new Date().toISOString() : null,
      }).eq("id", r.id);
      if (done) summary.failed++; else summary.retried++;
    }
  }
  return Response.json(summary);
});
