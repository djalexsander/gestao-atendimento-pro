import { supabase } from "../../lib/supabaseClient";
import { courtesyUnavailable, markCourtesyUnavailable, type CourtesyResult } from "./courtesyApi";
import { isRpcMissing } from "./courtesyLogic";
import { parseExtendResult, parseGrantResult, type ExtendResult, type GrantResult } from "./courtesyFormLogic";
import {
  parseConvertResult,
  parseEndResult,
  parseRequestResult,
  type ConvertResult,
  type EndResult,
  type RequestResult,
} from "./courtesyActionLogic";

// ESCRITA de cortesias (RPCs master_* com assert_master_admin no banco). Conceder e prorrogar (4B); encerrar, registrar pedido de conversão e
// autorizar/converter (4C). NADA aqui cria assinatura, fatura, Pix ou cobrança: a contratação paga continua sendo o formulário já existente
// "Contratar plano" (master_subscribe_company), que não passa por este módulo.
// Sem simulação de sucesso: se a RPC não existe no ambiente, devolve "unavailable" e nada é gravado. O erro real do banco (mensagem em
// português levantada pela própria função) é devolvido sem reescrita.

async function write<T>(fn: string, args: Record<string, unknown>, parse: (raw: unknown) => T | null): Promise<CourtesyResult<T>> {
  if (courtesyUnavailable()) return { status: "unavailable" };
  try {
    const { data, error, status } = await supabase.rpc(fn, args);
    if (error) {
      if (isRpcMissing({ code: error.code, message: error.message, status })) {
        markCourtesyUnavailable();
        return { status: "unavailable" };
      }
      return { status: "error", error: error.message };
    }
    const parsed = parse(data);
    return parsed === null ? { status: "error", error: "Resposta inesperada do servidor. Confira a lista antes de tentar de novo." } : { status: "ok", data: parsed };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Falha de rede. Confira a lista antes de tentar de novo." };
  }
}

export const grantCourtesy = (args: Record<string, unknown>): Promise<CourtesyResult<GrantResult>> =>
  write("master_grant_courtesy", args, parseGrantResult);

export const extendCourtesy = (args: Record<string, unknown>): Promise<CourtesyResult<ExtendResult>> =>
  write("master_extend_courtesy", args, parseExtendResult);

export const endCourtesy = (args: Record<string, unknown>): Promise<CourtesyResult<EndResult>> =>
  write("master_end_courtesy", args, parseEndResult);

export const requestCourtesyConversion = (args: Record<string, unknown>): Promise<CourtesyResult<RequestResult>> =>
  write("master_request_courtesy_conversion", args, parseRequestResult);

export const convertCourtesy = (args: Record<string, unknown>): Promise<CourtesyResult<ConvertResult>> =>
  write("master_convert_courtesy", args, parseConvertResult);
