import { useEffect, useState } from "react";
import { getCommercialSettings, type CommercialSettings } from "../features/master/commercialApi";
import { CORE_INCLUDED } from "../features/master/masterLogic";
import { formatCents } from "../lib/money";

// Somente leitura: as regras comerciais (trial, carência) são fixas no backend e não ficam dinâmicas nesta versão.
export function MasterSettingsPage() {
  const [s, setS] = useState<CommercialSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getCommercialSettings();
      if (cancelled) return;
      setS(r.data);
      setError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="form-error">{error}</div>;
  if (!s) return <p>Carregando configurações comerciais…</p>;

  return (
    <div>
      <div className="mst-head">
        <h2>Configurações comerciais</h2>
      </div>
      <p className="mst-sub">Regras vigentes, somente leitura. Alterá-las exige mudança no sistema; preços do Plano Base e dos módulos são editados em Planos e Módulos.</p>
      <div className="mst-grid-2">
        <section className="mst-card">
          <h3>Período grátis e cobrança</h3>
          <dl className="mst-dl">
            <dt>Trial</dt>
            <dd>{s.trialDays} dias, sem cobrança</dd>
            <dt>Após o trial</dt>
            <dd>Contratar o plano pago; cobrança integral e vencimento ancorado no dia da contratação</dd>
            <dt>Carência</dt>
            <dd>{s.graceDays} dias após o vencimento</dd>
          </dl>
        </section>
        <section className="mst-card">
          <h3>Valores</h3>
          <dl className="mst-dl">
            <dt>Plano Base</dt>
            <dd>{formatCents(s.basePriceCents)}/mês</dd>
            <dt>Módulos opcionais (todos)</dt>
            <dd>{formatCents(s.modulesTotalCents)}/mês</dd>
            <dt>Total completo</dt>
            <dd>
              <strong>{formatCents(s.fullTotalCents)}/mês</strong>
            </dd>
          </dl>
        </section>
      </div>
      <section className="mst-card">
        <h3>Incluído no Plano Base</h3>
        <p style={{ margin: 0 }}>{CORE_INCLUDED.join(" · ")}</p>
      </section>
    </div>
  );
}
