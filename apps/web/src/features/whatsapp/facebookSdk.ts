// Carregador do Facebook JavaScript SDK (oficial, https://connect.facebook.net/en_US/sdk.js). Só é carregado quando o usuário pede
// para conectar (nunca no início do app). Sem dependências do DOM real: o ambiente é injetado (testável).
import { FACEBOOK_SDK_URL, FACEBOOK_SDK_VERSION } from "./whatsappSignupLogic";

export interface FbLoginResponse {
  authResponse?: { code?: string } | null;
}
export interface FbLike {
  init(options: Record<string, unknown>): void;
  login(callback: (response: FbLoginResponse) => void, options: Record<string, unknown>): void;
}

export interface SdkEnv {
  win: { FB?: FbLike; fbAsyncInit?: () => void };
  doc: {
    getElementById(id: string): unknown;
    createElement(tag: string): { id: string; src: string; async: boolean; defer: boolean; crossOrigin: string | null; onerror: (() => void) | null };
    head: { appendChild(node: unknown): unknown };
  };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  timeoutMs: number;
}

const SCRIPT_ID = "facebook-jssdk";

export function browserSdkEnv(): SdkEnv {
  return {
    win: window as unknown as SdkEnv["win"],
    doc: document as unknown as SdkEnv["doc"],
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    timeoutMs: 15_000,
  };
}

/**
 * Carrega o SDK (uma vez) e o inicializa com o App ID da plataforma. Falha ("sdk_unavailable") se o script for bloqueado ou demorar.
 * autoLogAppEvents e xfbml ficam desligados de propósito: não precisamos que o SDK registre eventos do app na Meta nem varra o DOM
 * (a tela tem campo de PIN), e o Embedded Signup não depende dessas opções.
 */
export function loadFacebookSdk(appId: string, env: SdkEnv = browserSdkEnv()): Promise<FbLike> {
  return new Promise<FbLike>((resolve, reject) => {
    const init = (fb: FbLike) => fb.init({ appId, autoLogAppEvents: false, xfbml: false, version: FACEBOOK_SDK_VERSION });
    if (env.win.FB) {
      try {
        init(env.win.FB);
        resolve(env.win.FB);
      } catch {
        reject(new Error("sdk_unavailable"));
      }
      return;
    }
    let done = false;
    const timer = env.setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("sdk_unavailable"));
      }
    }, env.timeoutMs);
    env.win.fbAsyncInit = () => {
      if (done || !env.win.FB) return;
      try {
        init(env.win.FB);
      } catch {
        done = true;
        env.clearTimeout(timer);
        reject(new Error("sdk_unavailable"));
        return;
      }
      done = true;
      env.clearTimeout(timer);
      resolve(env.win.FB);
    };
    if (!env.doc.getElementById(SCRIPT_ID)) {
      const s = env.doc.createElement("script");
      s.id = SCRIPT_ID;
      s.src = FACEBOOK_SDK_URL;
      s.async = true;
      s.defer = true;
      s.crossOrigin = "anonymous";
      s.onerror = () => {
        if (!done) {
          done = true;
          env.clearTimeout(timer);
          reject(new Error("sdk_unavailable"));
        }
      };
      env.doc.head.appendChild(s);
    }
  });
}
