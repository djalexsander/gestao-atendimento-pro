// Atualização automática do Agente (regras puras). O download/assinatura ficam no Rust; aqui só o estado e a regra
// de segurança: NUNCA instalar com impressão em andamento.

export interface UpdateInfo {
  version: string;
  current: string;
}

// Ponte com o shell nativo. check() devolve null quando não há atualização (ou o updater ainda não está configurado).
export interface UpdaterPort {
  check(): Promise<UpdateInfo | null>;
  install(): Promise<void>;
}

export type UpdateStatus = "none" | "available" | "installing" | "error";

export interface UpdateSnapshot {
  status: UpdateStatus;
  info: UpdateInfo | null;
  message: string | null;
}

export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // ao iniciar e a cada 6 h

export const UPDATE_BUSY_MESSAGE = "Há impressão em andamento. A atualização só é instalada com o Agente ocioso; tente novamente em instantes.";

// Pode instalar agora? Devolve o motivo da recusa (ou null se pode).
export function installBlockReason(printing: boolean, status: UpdateStatus): string | null {
  if (status !== "available") return "Nenhuma atualização disponível.";
  if (printing) return UPDATE_BUSY_MESSAGE;
  return null;
}
