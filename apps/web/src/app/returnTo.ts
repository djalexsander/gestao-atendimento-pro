import { rememberablePath } from "./accessRules";

// Guarda (na aba, por pouco tempo) a rota que a pessoa tentou abrir sem sessão, para voltar a ela depois do login.
// Só rotas internas conhecidas (rememberablePath). sessionStorage pode falhar (modo privado): tudo é opcional.

const KEY = "gap.returnTo";
const TTL_MS = 15 * 60 * 1000;

interface Stored {
  path: string;
  at: number;
}

export function saveReturnPath(path: string, now: number = Date.now()): void {
  const safe = rememberablePath(path);
  if (!safe) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path: safe, at: now } satisfies Stored));
  } catch {
    /* sem armazenamento: segue sem destino */
  }
}

export function peekReturnPath(now: number = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    if (typeof stored.at !== "number" || now - stored.at > TTL_MS) return null;
    return rememberablePath(stored.path);
  } catch {
    return null;
  }
}

export function clearReturnPath(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
