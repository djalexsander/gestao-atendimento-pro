import { describeAccessCodeError } from "../../lib/accessCode";
import { supabase } from "../../lib/supabaseClient";

const LOAD_ERROR = "Não foi possível verificar o código da empresa agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar o código agora. Tente novamente.";

export interface AccessCodeState {
  // NULL só em empresa criada antes de o código ser obrigatório.
  accessCode: string | null;
  // Existe funcionário com login (ativo ou não)? É a mesma regra que trava a troca no banco.
  hasEmployees: boolean;
}

// Fonte de dados da seção "Código de acesso dos funcionários". Recebida por parâmetro (a real,
// abaixo, é o padrão) para poder exercitar a tela com dados simulados, sem login e sem banco. Quem
// manda de verdade é o banco: a RPC update_company_access_code + o trigger da tabela companies.
export interface AccessCodeSource {
  load(companyId: string): Promise<{ data: AccessCodeState | null; error: string | null }>;
  save(companyId: string, accessCode: string): Promise<{ error: string | null }>;
}

export const supabaseAccessCodeSource: AccessCodeSource = {
  // O código e a contagem vêm direto do banco (RLS de quem é owner/admin), e não do contexto de
  // login: atualizar o contexto remonta a tela inteira, e a seção precisa mostrar o resultado.
  async load(companyId) {
    const [company, employees] = await Promise.all([
      supabase.from("companies").select("access_code").eq("id", companyId).maybeSingle(),
      supabase
        .from("company_users")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .not("login", "is", null),
    ]);
    const failure = company.error ?? employees.error;
    if (failure || !company.data || employees.count === null) {
      console.error("Falha ao carregar o código de acesso da empresa:", failure?.code ?? "sem dados");
      return { data: null, error: LOAD_ERROR };
    }
    return {
      data: {
        accessCode: (company.data as { access_code: string | null }).access_code,
        hasEmployees: employees.count > 0,
      },
      error: null,
    };
  },

  async save(companyId, accessCode) {
    const { error } = await supabase.rpc("update_company_access_code", {
      p_company_id: companyId,
      p_access_code: accessCode,
    });
    if (error) {
      console.error("Falha ao salvar o código da empresa:", error.code);
      return { error: describeAccessCodeError(error, SAVE_ERROR) };
    }
    return { error: null };
  },
};
