import { useEffect, useState } from "react";
import { supabaseServiceModeSource, type ServiceModeSource } from "./serviceModeApi";
import type { ServiceMode } from "./panel";

const MODE_OPTIONS: Array<{ value: ServiceMode; label: string }> = [
  { value: "command", label: "Comandas" },
  { value: "table", label: "Mesas" },
  { value: "both", label: "Comandas e Mesas" },
];

// Modo de atendimento da empresa: define o que o Atendimento e o Caixa mostram e permitem abrir
// (company_operational_settings.service_mode). Vivia dentro de Cadastros → Comandas/Mesas; agora
// é usado só por Configurações → Modo de atendimento — mesma UI, mesma API (serviceModeApi.ts).
export function ServiceModeSection({
  companyId,
  source = supabaseServiceModeSource,
}: {
  companyId: string;
  source?: ServiceModeSource;
}) {
  const [mode, setMode] = useState<ServiceMode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void source.load(companyId).then((result) => {
      if (cancelled) return;
      if (result.error || result.mode === null) {
        setLoadError(result.error ?? "Não foi possível carregar o modo de atendimento agora.");
        return;
      }
      setLoadError(null);
      setMode(result.mode);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, source]);

  async function changeMode(next: ServiceMode) {
    if (saving || next === mode) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await source.save(companyId, next);
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMode(next);
    setNotice("Modo de atendimento atualizado.");
  }

  return (
    <fieldset className="mode-picker" disabled={mode === null || saving}>
      <legend>Modo de atendimento</legend>
      <div className="mode-options">
        {MODE_OPTIONS.map((option) => (
          <label key={option.value} className={`mode-option${mode === option.value ? " mode-option-selected" : ""}`}>
            <input
              type="radio"
              name="service-mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => void changeMode(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <p className="field-hint">
        Define o que o Atendimento e o Caixa mostram e permitem abrir. Cadastrar comandas e mesas não depende do
        modo.
      </p>
      {loadError && <div className="form-error">{loadError}</div>}
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}
    </fieldset>
  );
}
