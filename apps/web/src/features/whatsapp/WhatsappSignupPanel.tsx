import { useEffect, useRef, useState } from "react";
import { Modal } from "../employees/Modal";
import { launchSignup, prepareSignup, type FlowDeps, type LaunchHandle, type PreparedSignup, type SignupOutcome } from "./whatsappSignupFlow";
import {
  MAX_PIN_SUBMISSIONS,
  isValidPin,
  sanitizePinInput,
  signupFailure,
  type ConnectCard,
  type SignupFailure,
} from "./whatsappSignupLogic";

// Botão "Conectar meu WhatsApp" + janela do cadastro integrado da Meta (Embedded Signup v4).
// Segurança: o authorization code e o PIN nunca vão para localStorage/sessionStorage/estado persistente nem para log. O PIN fica numa
// ref/estado só até o envio e é apagado na hora; cada tentativa cria uma sessão NOVA e um cadastro NOVO na Meta (o code é de uso único),
// sempre por clique do usuário — nunca há nova tentativa automática.
type Phase =
  | { name: "idle" }
  | { name: "preparing" }
  | { name: "ready" }
  | { name: "waiting" }
  | { name: "finishing" }
  | { name: "success"; display: string | null; business: string | null }
  | { name: "failed"; failure: SignupFailure };

export function WhatsappSignupPanel({
  companyId,
  card,
  makeDeps,
  onConnected,
}: {
  companyId: string;
  card: ConnectCard;
  makeDeps: (companyId: string) => FlowDeps;
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [pinInput, setPinInput] = useState("");
  const [pinReady, setPinReady] = useState(false);
  const [pinSubmissions, setPinSubmissions] = useState(0);
  const preparedRef = useRef<PreparedSignup | null>(null);
  const handleRef = useRef<LaunchHandle | null>(null);
  const pinRef = useRef("");
  const aliveRef = useRef(true);
  const depsRef = useRef<FlowDeps | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      handleRef.current?.cancel();
      pinRef.current = "";
      preparedRef.current = null;
    };
  }, []);

  if (!card.visible) return null;

  const deps = (): FlowDeps => {
    if (!depsRef.current) depsRef.current = makeDeps(companyId);
    return depsRef.current;
  };

  async function prepare() {
    setPhase({ name: "preparing" });
    const r = await prepareSignup(deps());
    if (!aliveRef.current) return;
    if (r.ok) {
      preparedRef.current = r.prepared;
      setPhase({ name: "ready" });
    } else {
      pinRef.current = "";
      setPinReady(false);
      setPhase({ name: "failed", failure: r.failure });
    }
  }

  function reset() {
    handleRef.current?.cancel();
    handleRef.current = null;
    preparedRef.current = null;
    pinRef.current = "";
    setPinInput("");
    setPinReady(false);
    setPinSubmissions(0);
    setPhase({ name: "idle" });
  }

  function closeModal() {
    if (phase.name === "preparing" || phase.name === "waiting" || phase.name === "finishing") return;
    const done = phase.name === "success";
    reset();
    if (done) onConnected();
  }

  function onOutcome(o: SignupOutcome) {
    if (!aliveRef.current) return;
    handleRef.current = null;
    if (o.status === "success") setPhase({ name: "success", display: o.displayPhoneNumber, business: o.businessName });
    else if (o.status === "cancelled") setPhase({ name: "failed", failure: signupFailure("cancelled") });
    else setPhase({ name: "failed", failure: o.failure });
    setPinReady(false);
  }

  // O clique que chama FB.login (síncrono). Qualquer await antes disto faria o navegador bloquear o pop-up.
  function continueWithMeta() {
    const prepared = preparedRef.current;
    if (!prepared) return;
    preparedRef.current = null; // a sessão é de uso único
    const pin = pinRef.current;
    pinRef.current = ""; // o PIN sai da memória da tela assim que é entregue ao fluxo
    setPhase({ name: "waiting" });
    const handle = launchSignup(prepared, deps(), {
      pin: pin || undefined,
      onPhase: (p) => aliveRef.current && setPhase(p === "waiting" ? { name: "waiting" } : { name: "finishing" }),
    });
    handleRef.current = handle;
    void handle.outcome.then(onOutcome);
  }

  function submitPin() {
    if (!isValidPin(pinInput) || pinSubmissions >= MAX_PIN_SUBMISSIONS) return;
    pinRef.current = pinInput;
    setPinInput("");
    setPinReady(true);
    setPinSubmissions((n) => n + 1);
    void prepare();
  }

  const open = phase.name !== "idle";
  const failure = phase.name === "failed" ? phase.failure : null;
  const showPinForm = !!failure?.pinNeeded && pinSubmissions < MAX_PIN_SUBMISSIONS;
  const pinExhausted = !!failure?.pinNeeded && pinSubmissions >= MAX_PIN_SUBMISSIONS;

  return (
    <>
      <button type="button" className="btn-primary btn-auto" disabled={!card.enabled} title={card.hint ?? undefined} onClick={() => void prepare()}>
        {card.label}
      </button>
      {card.hint && <p className="field-hint" role="status">{card.hint}</p>}

      {open && (
        <Modal title={card.label} onClose={closeModal}>
          {phase.name === "preparing" && <p role="status">Preparando a conexão segura com a Meta…</p>}

          {phase.name === "ready" && (
            <>
              <p>
                Você será levado à janela segura da Meta para escolher ou criar sua conta do WhatsApp Business e confirmar o número.
                Não recebemos nem guardamos a sua senha da Meta.
              </p>
              {pinReady && <p className="form-notice" role="status">PIN recebido. Ele será usado uma única vez nesta tentativa.</p>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={reset}>Cancelar</button>
                <button type="button" className="btn-primary" onClick={continueWithMeta}>Continuar com a Meta</button>
              </div>
            </>
          )}

          {phase.name === "waiting" && <p role="status">Aguardando você concluir o cadastro na janela da Meta…</p>}
          {phase.name === "finishing" && <p role="status">Finalizando a conexão do número…</p>}

          {phase.name === "success" && (
            <>
              <div className="form-notice" role="status">
                WhatsApp conectado{phase.display ? `: ${phase.display}` : ""}.{phase.business ? ` ${phase.business}.` : ""} A conexão começa em modo de teste.
              </div>
              <div className="modal-actions">
                <button type="button" className="btn-primary" onClick={() => { reset(); onConnected(); }}>Concluir</button>
              </div>
            </>
          )}

          {phase.name === "failed" && failure && (
            <>
              <div className="form-error" role="alert">{failure.message}</div>
              {showPinForm && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitPin();
                  }}
                >
                  <div className="field">
                    <label htmlFor="wa-signup-pin">PIN de verificação em duas etapas (6 dígitos)</label>
                    <input
                      id="wa-signup-pin"
                      name="wa-signup-pin"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={6}
                      value={pinInput}
                      onChange={(e) => setPinInput(sanitizePinInput(e.target.value))}
                    />
                    <p className="field-hint">
                      É o PIN que já protege este número no WhatsApp. Ele é usado só nesta tentativa e não fica salvo no navegador. Por segurança, a
                      Meta pedirá a autorização novamente.
                    </p>
                  </div>
                  <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={reset}>Cancelar</button>
                    <button type="submit" className="btn-primary" disabled={!isValidPin(pinInput)}>Usar este PIN e continuar</button>
                  </div>
                </form>
              )}
              {pinExhausted && <p className="field-hint">Limite de tentativas de PIN nesta tela atingido. Fale com o suporte da Alex Pro Apps.</p>}
              {!showPinForm && (
                <div className="modal-actions">
                  <button type="button" className="btn-secondary" onClick={reset}>Fechar</button>
                  {failure.canRetry && !failure.pinNeeded && (
                    <button type="button" className="btn-primary" onClick={() => void prepare()}>Tentar novamente</button>
                  )}
                </div>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
