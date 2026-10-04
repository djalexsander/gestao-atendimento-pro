// Edge Function push-test: notificação de teste para UM aparelho do usuário autenticado. JWT obrigatório
// (verify_jwt = true em supabase/config.toml). A lógica está em handler.ts; aqui só se ligam as dependências reais.
//
// service_role: usado SOMENTE no servidor, para ler as credenciais do aparelho (push_test_target) e registrar o
// resultado (push_record_outcome). Nada disso chega ao browser. O usuário vem do JWT, nunca do corpo.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createWebPush, loadVapidConfig, sendOne } from "../_shared/web-push.ts";
import { handlePushTest } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) =>
  handlePushTest(req, {
    getUserId: async (jwt) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    loadTarget: async (userId, deviceId) => {
      const { data, error } = await admin.rpc("push_test_target", { p_user_id: userId, p_device_id: deviceId });
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const row = data[0] as { subscription_id: string; endpoint: string; p256dh: string; auth: string; url: string };
      return { subscriptionId: row.subscription_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, url: row.url };
    },
    send: (target, message, options) => {
      const config = loadVapidConfig();
      if (!config) return Promise.resolve({ outcome: "error" as const });
      return sendOne(createWebPush(config), target, message, options);
    },
    recordOutcome: async (subscriptionId, outcome) => {
      await admin.rpc("push_record_outcome", { p_subscription_id: subscriptionId, p_outcome: outcome });
    },
    vapidConfigured: () => loadVapidConfig() !== null,
    newId: () => crypto.randomUUID(),
  })
);
