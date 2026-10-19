// Edge Function whatsapp-ai-auto: WORKER da resposta automática por IA do WhatsApp (Fase 2). Chamada SÓ pelo banco
// (pg_cron -> whatsapp_ai_dispatch_due -> pg_net) com o segredo interno em x-internal-secret; sem JWT de usuário
// (verify_jwt = false em supabase/config.toml). A lógica está em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Edge Function secrets — NUNCA no git/frontend/VITE_):
//   WHATSAPP_AI_AUTO_SECRET        segredo compartilhado com o banco (>= 32 caracteres; o mesmo valor do Vault WHATSAPP_AI_AUTO_SECRET)
//   WHATSAPP_AI_AUTO_ENABLED       KILL SWITCH: só o valor exato "true" liga o automático. Ausente/outro => nada é processado.
//   WHATSAPP_AI_PROVIDER / WHATSAPP_AI_MODEL / WHATSAPP_AI_API_KEY   os MESMOS da sugestão (provedor/modelo/chave únicos)
//   WHATSAPP_GRAPH_API_VERSION     a MESMA do whatsapp-send (o token da Meta fica no Vault e é lido por get_send_context)
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { resolveDecider } from "../_shared/ai-openai.ts";
import type { FetchLike } from "../_shared/ai-openai.ts";
import { createGraphSender } from "../_shared/whatsapp-graph.ts";
import { handleWhatsappAiAuto } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const graph = createGraphSender((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappAiAuto(req, {
    internalSecret: Deno.env.get("WHATSAPP_AI_AUTO_SECRET"),
    killSwitch: Deno.env.get("WHATSAPP_AI_AUTO_ENABLED"),
    admin,
    decider: resolveDecider(
      {
        provider: Deno.env.get("WHATSAPP_AI_PROVIDER"),
        model: Deno.env.get("WHATSAPP_AI_MODEL"),
        apiKey: Deno.env.get("WHATSAPP_AI_API_KEY"),
      },
      ((url, init) => fetch(url, init as RequestInit)) as FetchLike,
    ),
    graph,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
  })
);
