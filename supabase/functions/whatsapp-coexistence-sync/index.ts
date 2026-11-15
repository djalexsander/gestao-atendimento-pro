// Edge Function whatsapp-coexistence-sync (verify_jwt = true em supabase/config.toml). Lógica em handler.ts; aqui só se ligam as dependências
// reais. NÃO FAZ DEPLOY até haver autorização: enquanto whatsapp_platform_settings.coexistence_sync_enabled for false (default), mesmo publicada
// ela responde 503 sem tocar na Meta. Secret usado: WHATSAPP_GRAPH_API_VERSION (já existente).
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createSmbSyncMeta } from "../_shared/whatsapp-signup-graph.ts";
import { handleWhatsappCoexistenceSync } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const meta = createSmbSyncMeta((url, init) => fetch(url, init as RequestInit));

Deno.serve((req: Request) =>
  handleWhatsappCoexistenceSync(req, {
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
    meta,
    graphVersion: Deno.env.get("WHATSAPP_GRAPH_API_VERSION"),
  })
);
