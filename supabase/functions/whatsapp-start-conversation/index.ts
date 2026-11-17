// Edge Function whatsapp-start-conversation (verify_jwt = true em supabase/config.toml). Lógica em handler.ts; aqui só se ligam as dependências reais.
// NÃO FAZ DEPLOY até haver autorização. Secret usado: WHATSAPP_GRAPH_API_VERSION (já existente). O token da Meta NÃO é secret desta função: fica no Vault e só sai
// em whatsapp_get_template_send_context (EXECUTE só service_role, depois do claim).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createTemplateSender } from "../_shared/whatsapp-template-send.ts";
import { handleWhatsappStartConversation } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sender = createTemplateSender((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappStartConversation(req, {
    createUserClient: (authorization: string) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    admin,
    sender,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
  })
);
