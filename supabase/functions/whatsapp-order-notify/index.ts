// Edge Function whatsapp-order-notify: WORKER dos avisos automáticos do pedido pelo WhatsApp. Chamada SÓ pelo banco
// (pg_cron -> order_notify_dispatch_due -> pg_net) com o segredo interno em x-internal-secret; sem JWT de usuário
// (verify_jwt = false em supabase/config.toml). A lógica está em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Edge Function secrets — NUNCA no git/frontend/VITE_):
//   WHATSAPP_ORDER_NOTIFY_SECRET    segredo compartilhado com o banco (>= 32 caracteres; o mesmo valor do Vault WHATSAPP_ORDER_NOTIFY_SECRET)
//   WHATSAPP_ORDER_NOTIFY_ENABLED   KILL SWITCH global: só o valor exato "true" liga os avisos. Ausente/outro => nada é enviado.
//   WHATSAPP_GRAPH_API_VERSION      a MESMA do whatsapp-send (o token da Meta fica no Vault e é lido por get_send_context)
// Não usa OpenAI: nenhuma chave de IA é necessária.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createGraphSender } from "../_shared/whatsapp-graph.ts";
import { handleWhatsappOrderNotify } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const graph = createGraphSender((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappOrderNotify(req, {
    internalSecret: Deno.env.get("WHATSAPP_ORDER_NOTIFY_SECRET"),
    killSwitch: Deno.env.get("WHATSAPP_ORDER_NOTIFY_ENABLED"),
    admin,
    graph,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
  })
);
