import { supabase } from "../../lib/supabaseClient";
import { describePrintError } from "./printingLogic";

const ERROR = "Não foi possível enviar para impressão agora. Tente novamente.";

// Documentos MANUAIS: só quando o usuário pede (botão ou F8). O cliente envia apenas o id; o
// snapshot do papel é montado no servidor. Sucesso = job criado (pending), NÃO "impresso": quem
// confirma a impressão real é o Agente de impressão (etapa futura).
export interface DocumentsSource {
  customerBill(serviceSessionId: string): Promise<{ error: string | null }>;
  paymentReceipt(serviceSessionId: string): Promise<{ error: string | null }>;
  cashClosing(cashSessionId: string): Promise<{ error: string | null }>;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`Falha em ${name}:`, error.code);
    return { error: describePrintError(error, ERROR) };
  }
  return { error: null };
}

export const supabaseDocumentsSource: DocumentsSource = {
  customerBill: (id) => call("enqueue_customer_bill", { p_service_session_id: id }),
  paymentReceipt: (id) => call("enqueue_payment_receipt", { p_service_session_id: id }),
  cashClosing: (id) => call("enqueue_cash_closing", { p_cash_session_id: id }),
};
