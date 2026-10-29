// Orquestração do cadastro integrado da Meta (Embedded Signup v4), sem React e sem DOM: tudo que toca o mundo externo é injetado.
//
// Duas etapas de propósito:
//   1) prepareSignup  — cria a sessão no banco (whatsapp_signup_begin) e carrega o SDK. Assíncrona.
//   2) launchSignup   — chama FB.login SINCRONAMENTE (dentro do clique do usuário, senão o navegador bloqueia o pop-up), escuta o
//                       postMessage da Meta e, assim que tem authorization code + IDs, envia IMEDIATAMENTE para a Edge.
// O authorization code vale ~30 s e é de uso único: ele só existe em variáveis locais desta função (nunca em storage, estado de tela
// ou log). Uma nova tentativa SEMPRE cria uma nova sessão e abre um novo cadastro — não há como reaproveitar code nem sessão.
import type { FbLike, FbLoginResponse } from "./facebookSdk";
import {
  SIGNUP_FINISH_WAIT_MS,
  isValidPin,
  parseSignupMessage,
  signupFailure,
  type SignupFailure,
  type SignupSession,
} from "./whatsappSignupLogic";

export interface CompletePayload {
  state: string;
  code: string;
  waba_id: string;
  phone_number_id: string;
  pin?: string;
}

export type BeginResult = { ok: true; session: SignupSession } | { ok: false; failure: SignupFailure };
export type CompleteResult = { ok: true; displayPhoneNumber: string | null; businessName: string | null } | { ok: false; failure: SignupFailure };

export interface FlowDeps {
  begin(): Promise<BeginResult>;
  loadSdk(appId: string): Promise<FbLike>;
  /** Registra o ouvinte de window "message" e devolve a função que o remove. */
  listen(handler: (event: { origin: string; data: unknown }) => void): () => void;
  complete(payload: CompletePayload): Promise<CompleteResult>;
  setTimer(fn: () => void, ms: number): () => void;
}

export interface PreparedSignup {
  session: SignupSession;
  fb: FbLike;
}

export type PrepareResult = { ok: true; prepared: PreparedSignup } | { ok: false; failure: SignupFailure };

export async function prepareSignup(deps: FlowDeps): Promise<PrepareResult> {
  const begun = await deps.begin();
  if (!begun.ok) return begun;
  try {
    const fb = await deps.loadSdk(begun.session.appId);
    return { ok: true, prepared: { session: begun.session, fb } };
  } catch {
    return { ok: false, failure: signupFailure("sdk_unavailable") };
  }
}

export type SignupOutcome =
  | { status: "success"; displayPhoneNumber: string | null; businessName: string | null }
  | { status: "cancelled" }
  | { status: "failed"; failure: SignupFailure };

export interface LaunchHandle {
  outcome: Promise<SignupOutcome>;
  /** Remove ouvintes e temporizadores (a tela foi fechada/desmontada). Não cancela uma conclusão já enviada ao servidor. */
  cancel(): void;
}

export function launchSignup(
  prepared: PreparedSignup,
  deps: FlowDeps,
  opts: { pin?: string; onPhase?: (phase: "waiting" | "finishing") => void } = {},
): LaunchHandle {
  const pin = opts.pin !== undefined && isValidPin(opts.pin) ? opts.pin : undefined;
  let cancelFn: () => void = () => undefined;

  const outcome = new Promise<SignupOutcome>((resolve) => {
    let code: string | null = null;
    let ids: { wabaId: string; phoneNumberId: string } | null = null;
    let completing = false;
    let settled = false;
    let stopListening: () => void = () => undefined;
    let stopTimer: () => void = () => undefined;

    const cleanup = () => {
      stopListening();
      stopTimer();
      code = null; // o code nunca sobrevive à tentativa
    };
    const settle = (o: SignupOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(o);
    };
    cancelFn = () => settle({ status: "cancelled" });

    const maybeComplete = () => {
      if (completing || settled || !code || !ids) return;
      completing = true;
      stopTimer();
      opts.onPhase?.("finishing");
      const payload: CompletePayload = {
        state: prepared.session.state,
        code,
        waba_id: ids.wabaId,
        phone_number_id: ids.phoneNumberId,
        ...(pin ? { pin } : {}),
      };
      code = null;
      deps.complete(payload).then(
        (r) => settle(r.ok ? { status: "success", displayPhoneNumber: r.displayPhoneNumber, businessName: r.businessName } : { status: "failed", failure: r.failure }),
        () => settle({ status: "failed", failure: signupFailure("generic") }),
      );
    };

    stopListening = deps.listen((event) => {
      if (settled || completing) return;
      const msg = parseSignupMessage(event.origin, event.data);
      if (!msg) return;
      if (msg.kind === "finish") {
        if (ids) {
          // FINISH repetido: o mesmo é ignorado; um que contradiz o primeiro é suspeito e encerra a tentativa (nada é enviado).
          if (ids.wabaId !== msg.wabaId || ids.phoneNumberId !== msg.phoneNumberId) settle({ status: "failed", failure: signupFailure("meta_error") });
          return;
        }
        ids = { wabaId: msg.wabaId, phoneNumberId: msg.phoneNumberId };
        maybeComplete();
      } else if (msg.kind === "cancel") {
        settle({ status: "cancelled" });
      } else if (msg.kind === "unsupported") {
        settle({ status: "failed", failure: signupFailure("unsupported") });
      } else {
        settle({ status: "failed", failure: signupFailure("meta_error") });
      }
    });

    const onLogin = (response: FbLoginResponse) => {
      if (settled || completing) return;
      const c = response?.authResponse?.code;
      if (typeof c !== "string" || c === "") {
        // sem authorization code: o usuário fechou a janela, ou o navegador bloqueou o pop-up
        settle({ status: "cancelled" });
        return;
      }
      code = c;
      opts.onPhase?.("waiting");
      if (!ids) {
        stopTimer = deps.setTimer(() => {
          if (!completing) settle({ status: "failed", failure: signupFailure("incomplete") });
        }, SIGNUP_FINISH_WAIT_MS);
      }
      maybeComplete();
    };

    try {
      // IMPORTANTE: chamada síncrona (ainda dentro do gesto do usuário). Parâmetros da documentação oficial do Embedded Signup v4.
      prepared.fb.login(onLogin, {
        config_id: prepared.session.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {} },
      });
    } catch {
      settle({ status: "failed", failure: signupFailure("sdk_unavailable") });
    }
  });

  return { outcome, cancel: () => cancelFn() };
}
