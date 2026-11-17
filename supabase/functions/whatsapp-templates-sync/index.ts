// Edge Function whatsapp-templates-sync (verify_jwt = true em supabase/config.toml). Lógica em handler.ts; aqui só se ligam as dependências reais.
// NÃO FAZ DEPLOY até haver autorização. SOMENTE leitura na Meta (GET message_templates). Secret usado: WHATSAPP_GRAPH_API_VERSION (já existente).
// O token da Meta NÃO é secret desta função: fica no Vault e é lido por whatsapp_templates_sync_context (EXECUTE só service_role).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createTemplatesLister } from "../_shared/whatsapp-templates-graph.ts";
import { handleWhatsappTemplatesSync } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const graph = createTemplatesLister((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappTemplatesSync(req, {
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
