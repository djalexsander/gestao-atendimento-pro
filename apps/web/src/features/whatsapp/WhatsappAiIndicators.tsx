import { useEffect, useState } from "react";
import { supabaseWhatsappModulesSource, type WhatsappModulesSource } from "./whatsappModulesApi";
import { OUTCOME_LABEL, type AiIndicators } from "./whatsappModulesLogic";

// Indicadores do atendimento automático (últimos 30 dias). Só owner/admin; o banco confere os dois módulos.
export function WhatsappAiIndicators({ companyId, source = supabaseWhatsappModulesSource }: { companyId: string; source?: WhatsappModulesSource }) {
  const [data, setData] = useState<AiIndicators | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void source.indicators(companyId).then((r) => {
      if (!alive) return;
      setData(r.data);
      setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [companyId, source]);

  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!data) return <p className="muted">Carregando indicadores…</p>;
  const outcomes = Object.entries(data.jobsByOutcome);
  return (
    <section className="settings-section wa-conn-card" aria-label="Indicadores da IA">
      <h3 className="settings-section-title">Indicadores dos últimos {data.periodDays} dias</h3>
      <dl className="wa-conn-stats">
        <div><dt>Respostas da IA</dt><dd>{data.aiReplies}</dd></div>
        <div><dt>Transferências para humano</dt><dd>{data.handoffs}</dd></div>
        <div><dt>Pedidos criados pela IA</dt><dd>{data.ordersByAi}</dd></div>
        <div><dt>Conversas com humano agora</dt><dd>{data.conversationsUnderHuman}</dd></div>
      </dl>
      {outcomes.length > 0 && (
        <ul className="wa-ind-list">
          {outcomes.map(([k, v]) => (
            <li key={k}>{OUTCOME_LABEL[k] ?? k}: <strong>{v}</strong></li>
          ))}
        </ul>
      )}
    </section>
  );
}
