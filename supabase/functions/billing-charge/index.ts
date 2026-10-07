// Edge Function billing-charge (OWNER, JWT). Lógica em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_): ASAAS_ENV (sandbox ou production),
// ASAAS_API_KEY. service_role só é usado aqui, no servidor, para as RPCs billing_*.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createAsaasClient, readAsaasConfig } from "../_shared/asaas-core.ts";
import { handleBillingCharge } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req: Request) => {
  const config = readAsaasConfig((name) => Deno.env.get(name));
  return handleBillingCharge(req, {
    config,
    db: admin,
    createAsaas: () => {
      if (!config.ok) throw new Error("Asaas não configurado");
      return createAsaasClient(config.config);
    },
    authenticate: async (jwt: string) => {
      const { data, error } = await admin.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    prepare: async (authorization: string, invoiceId: string) => {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await userClient.rpc("tenant_prepare_invoice_charge", { p_invoice_id: invoiceId });
      if (!error) return { ok: true };
      const status = ({ PT401: 401, PT403: 403, PT404: 404, PT409: 409 } as Record<string, number>)[error.code ?? ""];
      return status
        ? { ok: false, status, error: error.message }
        : { ok: false, status: 500, error: "Não foi possível concluir a operação agora. Tente novamente em instantes." };
    },
  });
});
