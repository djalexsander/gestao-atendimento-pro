// Edge Function whatsapp-ai-suggest: sugestão de resposta por IA (Fase 1; nunca envia mensagem). JWT obrigatório
// (verify_jwt em supabase/config.toml, e o banco confere papel/módulo/modo de novo). A lógica está em handler.ts.
//
// Secrets (Supabase Edge Function secrets — NUNCA no git/frontend/VITE_): WHATSAPP_AI_PROVIDER, WHATSAPP_AI_MODEL,
// WHATSAPP_AI_API_KEY. A empresa NÃO escolhe provedor/modelo. DECISÃO PENDENTE: o adapter do provedor real ainda não existe;
// sem ele (ou sem os secrets) a função falha fechada (503) e nada é enviado a terceiros.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import type { AiSuggester } from "../_shared/ai-suggester.ts";
import { handleWhatsappAiSuggest } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Registro de adapters (vazio na Fase 1): adicionar aqui, numa fase própria, o adapter do provedor escolhido.
const ADAPTERS: Record<string, (model: string, apiKey: string) => AiSuggester> = {};

function buildSuggester(): AiSuggester | null {
  const provider = Deno.env.get("WHATSAPP_AI_PROVIDER");
  const model = Deno.env.get("WHATSAPP_AI_MODEL");
  const apiKey = Deno.env.get("WHATSAPP_AI_API_KEY");
  if (!provider || !model || !apiKey) return null;
  const factory = ADAPTERS[provider];
  return factory ? factory(model, apiKey) : null;
}

Deno.serve((req: Request) =>
  handleWhatsappAiSuggest(req, {
    createUserClient: (authorization: string) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    admin,
    suggester: buildSuggester(),
  })
);
