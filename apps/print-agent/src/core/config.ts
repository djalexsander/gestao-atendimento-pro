// Estado local do agente. DIVISÃO DE SEGREDO:
//   * state.json (arquivo, app data): machine_id, agent_id e dados NÃO sensíveis.
//   * TOKEN: somente no Windows Credential Manager (SecretStore), nunca em arquivo, localStorage, log ou bundle.
// machine_id = UUID gerado na 1ª execução (nada de serial/MAC/hardware).

// Modo de impressão dos jobs do servidor. Não é segredo (fica no state.json). Padrão SEMPRE "simulation":
// só vira "real" por escolha explícita do usuário na interface (nunca por atualização ou padrão).
export type PrintMode = "simulation" | "real";

export interface StoredState {
  machineId: string;
  agentId: string | null;
  token: string | null; // só em memória; vem do SecretStore
  agentName: string | null;
  companyName: string | null;
  computerName: string | null;
  printMode: PrintMode;
  // Inicialização (não são segredos). Padrões: ligados; o Rust também lê keepBackground ao fechar a janela.
  autostart: boolean; // "Iniciar automaticamente com o Windows"
  keepBackground: boolean; // "Manter ativo em segundo plano" (X esconde na bandeja)
  trayNoticeShown: boolean; // o aviso "continuará ativo em segundo plano" já foi mostrado
}

export interface KeyValueStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

// Cofre do token (Windows Credential Manager). Sem fallback silencioso para texto puro: se o cofre
// falhar, o erro sobe e o pareamento NÃO continua.
export interface SecretStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export const SECRET_ERROR_MESSAGE = "Não foi possível armazenar com segurança a credencial do Agente.";

export class SecretStoreError extends Error {
  constructor() {
    super(SECRET_ERROR_MESSAGE);
  }
}

export const MACHINE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Lê o arquivo (SEM token: se um arquivo antigo tiver o campo, ele é ignorado e some na próxima gravação).
// Tolerante: JSON inválido, campos faltando ou tipos errados nunca derrubam o app (devolve null).
export function parseState(raw: string | null): StoredState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    // tolera BOM (arquivo salvo/editado por ferramentas do Windows)
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  const machineId = str(o.machineId);
  if (!machineId || !MACHINE_ID_PATTERN.test(machineId)) return null;
  const agentId = str(o.agentId);
  return {
    machineId,
    agentId,
    token: null,
    agentName: agentId ? str(o.agentName) : null,
    companyName: agentId ? str(o.companyName) : null,
    computerName: str(o.computerName),
    // Qualquer coisa diferente de "real" (ausente, inválido, arquivo antigo) = simulação.
    printMode: o.printMode === "real" ? "real" : "simulation",
    // Só `false` explícito desliga (arquivo antigo/ausente = padrão ligado).
    autostart: o.autostart !== false,
    keepBackground: o.keepBackground !== false,
    trayNoticeShown: o.trayNoticeShown === true,
  };
}

// O que vai para o arquivo: tudo, MENOS o token.
export function serializeState(state: StoredState): string {
  return JSON.stringify({
    machineId: state.machineId,
    agentId: state.agentId,
    agentName: state.agentName,
    companyName: state.companyName,
    computerName: state.computerName,
    printMode: state.printMode,
    autostart: state.autostart,
    keepBackground: state.keepBackground,
    trayNoticeShown: state.trayNoticeShown,
  });
}

export function isPaired(state: StoredState): boolean {
  return state.agentId !== null && state.token !== null;
}

// Carrega o estado e o token. Se não existir (ou estiver corrompido) cria um novo machine_id e PERSISTE.
// Agente registrado no arquivo mas sem token no cofre = não pareado (precisa reconectar).
// Falha do cofre: lança SecretStoreError (nunca cai para texto puro).
export async function loadOrCreateState(store: KeyValueStore, secrets: SecretStore, newId: () => string): Promise<StoredState> {
  const parsed = parseState(await store.load());
  if (parsed) {
    if (parsed.agentId === null) return parsed;
    let token: string | null;
    try {
      token = await secrets.get();
    } catch {
      throw new SecretStoreError();
    }
    if (token) return { ...parsed, token };
    const unpaired: StoredState = { ...parsed, agentId: null, agentName: null, companyName: null };
    await store.save(serializeState(unpaired));
    return unpaired;
  }
  const fresh: StoredState = { machineId: newId(), agentId: null, token: null, agentName: null, companyName: null, computerName: null, printMode: "simulation", autostart: true, keepBackground: true, trayNoticeShown: false };
  await store.save(serializeState(fresh));
  return fresh;
}

export async function saveState(store: KeyValueStore, state: StoredState): Promise<void> {
  await store.save(serializeState(state));
}

export interface PublicConfig {
  supabaseUrl: string;
  anonKey: string;
}

// URL + chave pública (anon). Nunca aceita nada que pareça chave de serviço.
export function parsePublicConfig(env: Record<string, unknown>): PublicConfig | null {
  const url = typeof env.VITE_SUPABASE_URL === "string" ? env.VITE_SUPABASE_URL.trim().replace(/\/+$/, "") : "";
  const key = typeof env.VITE_SUPABASE_ANON_KEY === "string" ? env.VITE_SUPABASE_ANON_KEY.trim() : "";
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return null;
  if (key.length < 20) return null;
  return { supabaseUrl: url, anonKey: key };
}
