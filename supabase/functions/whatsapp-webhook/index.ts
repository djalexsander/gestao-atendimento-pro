// Edge Function whatsapp-webhook (pública; verify_jwt = false em supabase/config.toml — a autenticação é a assinatura da Meta).
// Lógica em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_):
//   WHATSAPP_VERIFY_TOKEN  string escolhida por nós, a mesma cadastrada no painel da Meta (verificação do webhook)
//   WHATSAPP_APP_SECRET    App Secret do app Meta (valida X-Hub-Signature-256)
// URL a cadastrar na Meta: https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { handleWhatsappWebhook } from "./handler.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) =>
  handleWhatsappWebhook(req, {
    verifyToken: Deno.env.get("WHATSAPP_VERIFY_TOKEN"),
    appSecret: Deno.env.get("WHATSAPP_APP_SECRET"),
    db: {
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        return { data, error: error ? { message: error.message, code: error.code } : null };
      },
    },
  }),
);
