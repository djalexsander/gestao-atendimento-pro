// Edge Function whatsapp-send: envio manual de mensagem de WhatsApp. JWT obrigatório (verify_jwt em supabase/config.toml, e o
// banco confere o papel/módulo de novo). A lógica está em handler.ts; aqui só se ligam as dependências reais.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_): WHATSAPP_GRAPH_API_VERSION (versão vigente da
// Graph API, conferida na documentação da Meta no deploy; sem default no código). O token da Meta NÃO é secret desta função:
// fica no Vault e é lido por whatsapp_get_send_context (EXECUTE só service_role).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createGraphSender } from "../_shared/whatsapp-graph.ts";
import { handleWhatsappSend } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const graph = createGraphSender((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappSend(req, {
    createUserClient: (authorization: string) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    admin,
    graph,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
  })
);
