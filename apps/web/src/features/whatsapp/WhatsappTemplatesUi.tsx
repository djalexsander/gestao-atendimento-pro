import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../employees/Modal";
import type { StartSource } from "./whatsappStartApi";
import { sendableTemplates, templateLabel, unsupportedTemplateCount, type StartTemplates } from "./whatsappStartLogic";
import type { TemplatesSyncSource } from "./whatsappTemplatesSyncApi";
import { categoryLabel, SYNC_TEXT, syncSummary, type SyncOutcome } from "./whatsappTemplatesSyncLogic";

// Atualizar templates (Etapa 7.11M). Mesmo painel na empresa (owner/admin, dentro de Contatos) e no Painel Master. O botão só chama a Edge
// whatsapp-templates-sync com a sessão do usuário; quem pode é decidido no servidor. Nada é sincronizado sozinho: só por clique.

type Listing = { status: "loading" } | { status: "ready"; data: StartTemplates } | { status: "unavailable" };

export function TemplatesSyncPanel({ companyId, sync, source }: { companyId: string; sync: TemplatesSyncSource; /** leitura dos templates (só quem participa da empresa) */ source?: StartSource }) {
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const token = useRef(0);
  const [listing, setListing] = useState<Listing>(source ? { status: "loading" } : { status: "unavailable" });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadList = useCallback(async () => {
    if (!source) return;
    const t = ++token.current;
    const r = await source.templates(companyId);
    if (!alive.current || t !== token.current) return; // resposta de outra empresa/consulta antiga
    setListing(r.ok ? { status: "ready", data: r.data } : { status: "unavailable" });
  }, [source, companyId]);
  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function run() {
    if (busyRef.current) return; // clique repetido: uma atualização por vez
    busyRef.current = true;
    setBusy(true);
    setOutcome(null);
    const o = await sync.sync(companyId);
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(false);
    setOutcome(o);
    if (o.kind === "ok") await loadList();
  }

  const sendable = listing.status === "ready" ? sendableTemplates(listing.data) : [];
  const unsupported = listing.status === "ready" ? unsupportedTemplateCount(listing.data) : 0;
  return (
    <div className="wa-tpl" data-testid="wa-templates-panel">
      <p className="muted">{SYNC_TEXT.idle}</p>
      <div className="wa-tpl-actions">
        <button type="button" className="btn-primary" data-testid="wa-templates-sync" disabled={busy} onClick={() => void run()}>
          {busy ? SYNC_TEXT.running : "Atualizar templates"}
        </button>
      </div>
      {outcome && (
        <div className={outcome.kind === "error" ? "form-error" : outcome.kind === "running" ? "mst-banner" : "form-notice"} role={outcome.kind === "error" ? "alert" : "status"} data-testid="wa-templates-result">
          {syncSummary(outcome)}
        </div>
      )}
      {listing.status === "loading" && <p className="muted">Carregando templates…</p>}
      {listing.status === "unavailable" && source && <p className="muted">A lista de templates não está disponível para esta conta agora.</p>}
      {listing.status === "ready" && (
        <>
          <p className="wa-tpl-count" data-testid="wa-templates-count">
            {listing.data.connected ? "" : "WhatsApp desconectado. "}
            {listing.data.stale ? "A lista pode estar desatualizada. " : ""}
            Aprovados e prontos para envio: {sendable.length}
            {unsupported > 0 ? ` · aprovados sem suporte nesta versão: ${unsupported}` : ""}
          </p>
          {listing.data.templates.length === 0 ? (
            <p className="muted">Nenhum template aprovado no cache. Use “Atualizar templates”.</p>
          ) : (
            <ul className="wa-tpl-list">
              {listing.data.templates.map((t) => (
                <li key={t.id} className="wa-tpl-item" data-testid="wa-template-item">
                  <strong>{templateLabel(t)}</strong>
                  <span className="muted">
                    {" "}
                    · {categoryLabel(t.category)} · {t.variableCount} variável(is)
                  </span>
                  {t.eligible ? null : <span className="muted"> · não suportado{t.ineligibleReason ? `: ${t.ineligibleReason}` : ""}</span>}
                  {t.bodyText && <div className="wa-tpl-body">{t.bodyText}</div>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function TemplatesDialog({ companyId, sync, source, onClose }: { companyId: string; sync: TemplatesSyncSource; source: StartSource; onClose: () => void }) {
  return (
    <Modal title="Templates do WhatsApp" onClose={onClose}>
      <TemplatesSyncPanel companyId={companyId} sync={sync} source={source} />
      <div className="mst-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
