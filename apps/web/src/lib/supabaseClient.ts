import { createClient } from "@supabase/supabase-js";
import { READ_ONLY_EVENT, wrapFetchForReadOnly } from "../features/commercial/commercialLogic";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY precisam estar definidas (veja .env.example na raiz do projeto).",
  );
}

// Tratamento CENTRAL do PT402 (empresa em somente leitura): toda resposta 402 do banco vira a mensagem amigável e avisa o
// estado comercial global — nenhuma tela precisa tratar isso à mão. A barreira em si é do banco.
const fetchWithReadOnlyGuard = wrapFetchForReadOnly((input, init) => fetch(input, init), () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(READ_ONLY_EVENT));
});

export const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: fetchWithReadOnlyGuard } });
