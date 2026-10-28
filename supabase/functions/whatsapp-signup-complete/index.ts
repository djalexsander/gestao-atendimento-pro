// Edge Function whatsapp-signup-complete (verify_jwt = true em supabase/config.toml). Lógica em handler.ts; aqui só se ligam as
// dependências reais. NÃO FAZ DEPLOY até haver autorização: enquanto whatsapp_platform_settings.embedded_signup_enabled for false,
// mesmo publicada ela responde 503 antes de tocar em qualquer sessão.
//
// Secrets (Edge Function secrets — NUNCA no git/frontend/VITE_):
//   WHATSAPP_GRAPH_API_VERSION         já existente (envio); versão vigente da Graph API
//   WHATSAPP_APP_SECRET                já existente (assinatura do webhook) = App Secret do app Meta; usado na troca do code
// Não há secret de PIN: cada número recebe um PIN aleatório guardado no Vault (ou o PIN informado pelo cliente).
// O App ID e o Config ID não são secrets: vêm de whatsapp_platform_settings (preenchidos pelo operador).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createSignupMeta } from "../_shared/whatsapp-signup-graph.ts";
import { handleWhatsappSignupComplete } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const meta = createSignupMeta((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappSignupComplete(req, {
    authenticate: async (authorization: string) => {
      const jwt = authorization.replace(/^Bearer\s+/i, "");
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await userClient.auth.getUser(jwt);
      return error || !data.user ? null : { userId: data.user.id };
    },
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error: error ? { message: error.message, code: error.code } : null };
    },
    platform: async () => {
      const { data, error } = await admin.from("whatsapp_platform_settings").select("embedded_signup_enabled, meta_app_id").maybeSingle();
      if (error || !data) return null;
      return { enabled: data.embedded_signup_enabled === true, appId: data.meta_app_id ?? null };
    },
    findPhoneOwner: async (phoneNumberId: string) => {
      const { data, error } = await admin.from("company_whatsapp_connections").select("company_id").eq("phone_number_id", phoneNumberId).limit(1);
      if (error) throw new Error("lookup");
      return data && data.length ? { companyId: String(data[0].company_id) } : null;
    },
    findActiveConnection: async (companyId: string) => {
      const { data, error } = await admin.from("company_whatsapp_connections").select("phone_number_id").eq("company_id", companyId).eq("status", "active").limit(1);
      if (error) throw new Error("lookup");
      return data && data.length ? { phoneNumberId: data[0].phone_number_id ?? null } : null;
    },
    meta,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
    appSecret: Deno.env.get("WHATSAPP_APP_SECRET"),
  })
);
