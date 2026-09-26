// Edge Function employee-admin: gestão de funcionários (contas gerenciadas do
// Supabase Auth). JWT obrigatório (verify_jwt em supabase/config.toml, e o handler
// valida o token de novo). A lógica está em handler.ts; aqui só se ligam as
// dependências reais.
//
// service_role: só a Auth Admin API (criar usuário, trocar credencial, banir,
// apagar) sai daqui para o handler — nunca o client inteiro — e nada disso chega
// ao browser. As escritas em tabela são RPCs chamadas com o JWT do próprio ator.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { handleEmployeeAdmin } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const authAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

Deno.serve((req: Request) =>
  handleEmployeeAdmin(req, {
    // Client escopado ao JWT de quem chamou: auth.uid() nas RPCs é o dono/admin.
    createUserClient: (authorization: string) =>
      createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    authAdmin,
  })
);
