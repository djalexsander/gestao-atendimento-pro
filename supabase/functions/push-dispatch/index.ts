// Edge Function push-dispatch: entrega o Web Push de um push_event. Chamada SÓ pelo banco (pg_net) com o segredo
// compartilhado (x-internal-secret); verify_jwt = false em supabase/config.toml. A lógica está em handler.ts; aqui
// só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets, NUNCA no git/frontend): PUSH_DISPATCH_SECRET (>= 32 caracteres),
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. service_role só é usado aqui, no servidor, para as funções
// push_* do banco (claim, destinatários, resultado, fechamento).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createWebPush, loadVapidConfig, sendOne } from "../_shared/web-push.ts";
import { handlePushDispatch, type ClaimedEvent, type EventTarget } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) =>
  handlePushDispatch(req, {
    internalSecret: Deno.env.get("PUSH_DISPATCH_SECRET"),
    vapidConfigured: () => loadVapidConfig() !== null,
    claimEvent: async (eventId) => {
      const { data, error } = await admin.rpc("push_claim_event", { p_event_id: eventId });
      if (error) throw error;
      return Array.isArray(data) && data.length > 0 ? (data[0] as ClaimedEvent) : null;
    },
    loadTargets: async (eventId) => {
      const { data, error } = await admin.rpc("push_event_targets", { p_event_id: eventId });
      if (error) throw error;
      return ((data ?? []) as Array<{ subscription_id: string; endpoint: string; p256dh: string; auth: string; url: string }>).map(
        (row): EventTarget => ({ subscription_id: row.subscription_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, url: row.url }),
      );
    },
    send: (target, message, options) => {
      const config = loadVapidConfig();
      if (!config) return Promise.resolve({ outcome: "error" as const });
      return sendOne(createWebPush(config), target, message, options);
    },
    recordOutcome: async (subscriptionId, outcome) => {
      await admin.rpc("push_record_outcome", { p_subscription_id: subscriptionId, p_outcome: outcome });
    },
    finishEvent: async (eventId, sent, failed, error) => {
      await admin.rpc("push_finish_event", { p_event_id: eventId, p_sent: sent, p_failed: failed, p_error: error });
    },
  })
);
