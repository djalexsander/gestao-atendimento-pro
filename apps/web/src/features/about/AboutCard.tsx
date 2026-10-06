import { useState } from "react";
import { checkDesktopUpdate } from "../../lib/appVersion";
import { useAppVersion } from "../../lib/useAppVersion";

const MESSAGE = {
  uptodate: "Você já está usando a versão mais recente.",
  available: "Há uma nova versão disponível. Siga as instruções na janela de atualização.",
  unavailable: "Não foi possível verificar atualização agora. Tente novamente em instantes.",
} as const;

// Sistema / Preferências → Sobre. Desktop: versão real + "Verificar atualização" (updater do Tauri). PWA: só a versão web.
export function AboutCard() {
  const { version, runtime } = useAppVersion();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setNote(null);
    const result = await checkDesktopUpdate();
    setChecking(false);
    setNote(MESSAGE[result]);
  }

  return (
    <section className="sys-card" aria-label="Sobre">
      <h3>Sobre</h3>
      <p className="about-name">Gestão Atendimento Pro</p>
      <p className="about-version">{runtime === "desktop" ? `Versão ${version}` : `Versão web ${version}`}</p>
      {runtime === "desktop" && (
        <>
          <button type="button" className="btn-secondary btn-auto" disabled={checking} onClick={check}>
            {checking ? "Verificando…" : "Verificar atualização"}
          </button>
          {note && (
            <p className="field-hint" role="status">
              {note}
            </p>
          )}
        </>
      )}
    </section>
  );
}
