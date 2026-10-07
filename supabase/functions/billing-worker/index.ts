// Edge Function billing-worker (chamada SÓ pelo banco via pg_net; verify_jwt = false em supabase/config.toml).
// Lógica em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_): BILLING_WORKER_SECRET (>= 32 caracteres; o
// mesmo valor vai para o vault do banco como BILLING_WORKER_SECRET, com a URL em BILLING_WORKER_URL), ASAAS_ENV
// (sandbox ou production), ASAAS_API_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createAsaasClient, readAsaasConfig } from "../_shared/asaas-core.ts";
import { handleBillingWorker } from "./handler.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) => {
  const config = readAsaasConfig((name) => Deno.env.get(name));
  return handleBillingWorker(req, {
    internalSecret: Deno.env.get("BILLING_WORKER_SECRET"),
    config,
    db: admin,
    createAsaas: () => {
      if (!config.ok) throw new Error("Asaas não configurado");
      return createAsaasClient(config.config);
    },
    today: () => new Date().toISOString().slice(0, 10),
  });
});
