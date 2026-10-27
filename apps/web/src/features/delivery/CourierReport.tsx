import { useEffect, useState } from "react";
import { formatReais } from "../../lib/money";
import type { DeliverySource } from "./deliveryApi";
import { formatAvgMinutes, periodDates, type CourierStat } from "./deliveryLogic";

type Preset = "today" | "week" | "month";
const PRESET_LABEL: Record<Preset, string> = { today: "Hoje", week: "Últimos 7 dias", month: "Últimos 30 dias" };

function rangeOf(p: Preset, now: Date = new Date()): { from: string; to: string } {
  const today = periodDates("today", { from: "", to: "" }, now).to;
  if (p === "today") return { from: today, to: today };
  const back = p === "week" ? 6 : 29;
  const from = periodDates("today", { from: "", to: "" }, new Date(now.getTime() - back * 24 * 3600 * 1000)).to;
  return { from, to: today };
}

// Indicadores simples por entregador (leitura; owner/admin/cashier). Os números vêm do servidor (delivery_courier_report).
export function CourierReport({ companyId, source }: { companyId: string; source: DeliverySource }) {
  const [preset, setPreset] = useState<Preset>("week");
  const [rows, setRows] = useState<CourierStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    const { from, to } = rangeOf(preset);
    void source.courierReport(companyId, from, to).then((r) => {
      if (!live) return;
      if (r.data) setRows(r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [source, companyId, preset]);

  return (
    <section className="dl-card-box dl-report" aria-label="Indicadores por entregador">
      <div className="dl-zones-head">
        <h3>Entregadores</h3>
        <select aria-label="Período dos indicadores" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
        </select>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {!rows && !error && <p className="muted">Carregando…</p>}
      {rows && rows.length === 0 && <p className="muted">Nenhum pedido com entregador neste período.</p>}
      {rows && rows.length > 0 && (
        <ul className="dl-zone-list">
          {rows.map((c) => (
            <li key={c.courierUserId}>
              <span className="dl-zone-main">
                <strong>{c.name}</strong>
                <span className="muted">{c.assigned} {c.assigned === 1 ? "pedido" : "pedidos"} · tempo médio {formatAvgMinutes(c.avgMinutes)}</span>
              </span>
              <span><strong>{c.delivered}</strong> entregues</span>
              <span className="muted">{c.inRoute} em rota · {c.waiting} aguardando</span>
              <span className="muted">{c.refused} recusadas · {c.canceled} canceladas</span>
              <span>{formatReais(c.deliveredTotal)}{c.fees > 0 ? <span className="muted"> (taxas {formatReais(c.fees)})</span> : null}</span>
              {c.heldAmount > 0 && <span className="status-badge status-inactive">Em custódia {formatReais(c.heldAmount)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
