// Edge Function asaas-webhook (pública; verify_jwt = false em supabase/config.toml — a autenticação é o token do webhook).
// Lógica em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_): ASAAS_WEBHOOK_TOKEN (o mesmo cadastrado no
// painel Sandbox do Asaas), ASAAS_ENV (sandbox ou production), ASAAS_API_KEY. URL a cadastrar no Asaas:
//   https://<project-ref>.supabase.co/functions/v1/asaas-webhook
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createAsaasClient, readAsaasConfig, sha256Hex } from "../_shared/asaas-core.ts";
import { handleAsaasWebhook } from "./handler.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) => {
  const config = readAsaasConfig((name) => Deno.env.get(name));
  return handleAsaasWebhook(req, {
    config,
    webhookToken: Deno.env.get("ASAAS_WEBHOOK_TOKEN"),
    db: admin,
    createAsaas: () => {
      if (!config.ok) throw new Error("Asaas não configurado");
      return createAsaasClient(config.config);
    },
    sha256: sha256Hex,
  });
});
