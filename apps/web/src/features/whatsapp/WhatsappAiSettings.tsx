import { useEffect, useState } from "react";
import { supabaseAiSettingsSource, type AiSettingsSource } from "./whatsappAiApi";
import { aiSettingsError, type AiSettings } from "./whatsappLogic";

// Configurações → IA do WhatsApp (owner/admin). Fase 1: só "Sugestão" (a IA nunca envia). "Automático" aparece
// desabilitado. Antes de ativar, o dono confirma a ciência sobre o tratamento dos dados; o banco confere de novo.
export function WhatsappAiSettings({ companyId, source = supabaseAiSettingsSource }: { companyId: string; source?: AiSettingsSource }) {
  const [loaded, setLoaded] = useState<AiSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<"off" | "suggest">("off");
  const [businessName, setBusinessName] = useState("");
  const [tone, setTone] = useState("");
  const [businessHours, setBusinessHours] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [fallbackToHuman, setFallbackToHuman] = useState(true);
  const [maxContext, setMaxContext] = useState("12");
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = (s: AiSettings) => {
    setLoaded(s);
    setEnabled(s.enabled);
    setMode(s.mode === "suggest" ? "suggest" : "off");
    setBusinessName(s.businessName);
    setTone(s.tone);
    setBusinessHours(s.businessHours);
    setCustomInstructions(s.customInstructions);
    setFallbackToHuman(s.fallbackToHuman);
    setMaxContext(String(s.maxContextMessages));
    setAck(s.acknowledgedAt !== null);
  };

  useEffect(() => {
    let alive = true;
    void source.get(companyId).then((r) => {
      if (!alive) return;
      if (r.data) apply(r.data);
      else setLoadError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [companyId, source]);

  async function save() {
    const max = Number(maxContext);
    const problem = aiSettingsError({ businessName, tone, customInstructions, businessHours, maxContextMessages: max, enabled }, ack);
    if (problem) return setMessage({ kind: "err", text: problem });
    setSaving(true);
    setMessage(null);
    const r = await source.save(companyId, {
      enabled,
      mode: enabled ? mode : "off",
      businessName,
      tone,
      customInstructions,
      businessHours,
      fallbackToHuman,
      maxContextMessages: max,
      acknowledge: ack,
    });
    setSaving(false);
    if (r.data) {
      apply(r.data);
      setMessage({ kind: "ok", text: "Configuração da IA salva." });
    } else {
      setMessage({ kind: "err", text: r.error });
    }
  }

  if (loadError) return <div className="form-error" role="alert">{loadError}</div>;
  if (!loaded) return <p className="muted">Carregando…</p>;
  const alreadyAcknowledged = loaded.acknowledgedAt !== null;

  return (
    <div className="dl-settings">
      <section className="dl-card-box">
        <h3>IA do WhatsApp</h3>
        <p className="field-hint">
          A IA só sugere uma resposta para o atendente revisar e editar. Ela nunca envia mensagens sozinha: o envio continua sendo
          feito pelo botão Enviar.
        </p>
        <label className="dl-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              if (e.target.checked && mode === "off") setMode("suggest");
            }}
          />
          Ativar IA para sugestões
        </label>
        <fieldset className="dl-field" disabled={!enabled}>
          <legend>Modo</legend>
          <label className="dl-check"><input type="radio" name="wa-ai-mode" checked={mode === "off"} onChange={() => setMode("off")} /> Desativado</label>
          <label className="dl-check"><input type="radio" name="wa-ai-mode" checked={mode === "suggest"} onChange={() => setMode("suggest")} /> Sugestão (o atendente revisa e envia)</label>
          <label className="dl-check"><input type="radio" name="wa-ai-mode" disabled checked={false} readOnly /> Automático — em breve</label>
        </fieldset>

        <div className="dl-grid2">
          <label className="dl-field"><span>Nome do estabelecimento</span><input maxLength={120} value={businessName} onChange={(e) => setBusinessName(e.target.value)} /></label>
          <label className="dl-field"><span>Tom de voz</span><input maxLength={80} placeholder="Ex.: cordial e direto" value={tone} onChange={(e) => setTone(e.target.value)} /></label>
          <label className="dl-field"><span>Horário de atendimento</span><input maxLength={300} placeholder="Ex.: Seg a Sex, 9h às 18h" value={businessHours} onChange={(e) => setBusinessHours(e.target.value)} /></label>
          <label className="dl-field"><span>Mensagens de contexto (1 a 30)</span><input inputMode="numeric" value={maxContext} onChange={(e) => setMaxContext(e.target.value)} /></label>
        </div>
        <label className="dl-field dl-field-wide">
          <span>Instruções adicionais (opcional)</span>
          <textarea rows={3} maxLength={2000} value={customInstructions} onChange={(e) => setCustomInstructions(e.target.value)} />
        </label>
        <label className="dl-check">
          <input type="checkbox" checked={fallbackToHuman} onChange={(e) => setFallbackToHuman(e.target.checked)} />
          Transferir para um atendente humano quando necessário
        </label>

        <label className="dl-check">
          <input type="checkbox" checked={ack} disabled={alreadyAcknowledged} onChange={(e) => setAck(e.target.checked)} />
          Entendo que trechos da conversa poderão ser enviados a um provedor de IA para gerar a sugestão. Telefone, e-mail e
          documentos não são enviados.
        </label>
        {alreadyAcknowledged && <p className="field-hint">Ciência registrada.</p>}

        {message && <div className={message.kind === "ok" ? "form-notice" : "form-error"} role={message.kind === "ok" ? "status" : "alert"}>{message.text}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-primary btn-auto" disabled={saving} onClick={() => void save()}>{saving ? "Salvando…" : "Salvar configuração"}</button>
        </div>
      </section>
    </div>
  );
}
