import { useEffect, useState, type FormEvent } from "react";
import { listModules, listPlans, saveModule } from "../features/master/catalogApi";
import { isCommercialModule, MODULE_FEATURES, totalBreakdown } from "../features/master/masterLogic";
import { Badge } from "../features/master/MasterBits";
import { formatCents, parseCents } from "../lib/money";
import type { CatalogModule } from "../lib/types";

interface FormState {
  id: string;
  code: string;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
}

export function MasterModulesPage() {
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [baseCents, setBaseCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [m, p] = await Promise.all([listModules(), listPlans()]);
      if (cancelled) return;
      // Só os módulos comerciais oficiais aparecem: o núcleo está no Plano Base e não é módulo pago.
      setModules(m.data.filter((x) => isCommercialModule(x.code)));
      setBaseCents(p.data.find((x) => x.code === "base")?.monthlyPriceCents ?? 0);
      setError(m.error ?? p.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function edit(m: CatalogModule) {
    setError(null);
    setForm({ id: m.id, code: m.code, name: m.name, description: m.description ?? "", price: (m.monthlyPriceCents / 100).toFixed(2).replace(".", ","), isActive: m.isActive });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const cents = parseCents(form.price);
    if (cents === null) {
      setError("Preço inválido. Use o formato 19,90.");
      return;
    }
    setError(null);
    setSaving(true);
    const { error } = await saveModule({ id: form.id, code: form.code, name: form.name, description: form.description, monthlyPriceCents: cents, isActive: form.isActive });
    setSaving(false);
    if (error) {
      setError(error);
      return;
    }
    setForm(null);
    setReloadKey((k) => k + 1);
  }

  if (loading) return <p>Carregando módulos…</p>;

  const active = modules.filter((m) => m.isActive);
  const { totalCents } = totalBreakdown(baseCents, active.map((m) => ({ name: m.name, priceCents: m.monthlyPriceCents })));
  const modulesCents = totalCents - baseCents;

  return (
    <div>
      <div className="mst-head">
        <h2>Módulos</h2>
      </div>
      <div className="mst-banner">
        Plano Base + todos os módulos: {formatCents(totalCents)}/mês
        <span>
          Base {formatCents(baseCents)} + módulos {formatCents(modulesCents)}. Atendimento, Comandas/Mesas, Pedidos, Caixa básico, Clientes, Dashboard e Configurações fazem parte do Plano Base.
        </span>
      </div>

      {error && <div className="form-error">{error}</div>}

      {form && (
        <form onSubmit={submit} className="mst-card" style={{ maxWidth: 520 }}>
          <h3>Editar módulo</h3>
          <div className="field">
            <label htmlFor="mod-code">Código (não pode ser alterado)</label>
            <input id="mod-code" disabled value={form.code} readOnly />
          </div>
          <div className="field">
            <label htmlFor="mod-name">Nome</label>
            <input id="mod-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="mod-desc">Descrição</label>
            <input id="mod-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="mod-price">Preço mensal (R$)</label>
            <input id="mod-price" required inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </div>
          <label style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Ativo
          </label>
          <p className="mst-sub" style={{ marginTop: 0 }}>
            Mudar o preço vale para novas contratações; contratos já firmados mantêm o valor contratado.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary" type="submit" disabled={saving} style={{ width: "auto" }}>
              {saving ? "Salvando…" : "Salvar"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => setForm(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="mst-scroll">
        <table className="mst-table">
          <thead>
            <tr>
              <th>Módulo</th>
              <th>Código</th>
              <th>O que inclui</th>
              <th className="mst-num">Preço mensal</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  {m.description && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{m.description}</div>}
                </td>
                <td>{m.code}</td>
                <td>{(MODULE_FEATURES[m.code] ?? []).join(" · ") || "—"}</td>
                <td className="mst-num">{formatCents(m.monthlyPriceCents)}</td>
                <td>
                  <Badge tone={m.isActive ? "ok" : "muted"}>{m.isActive ? "Ativo" : "Inativo"}</Badge>
                </td>
                <td>
                  <button className="btn-secondary" type="button" onClick={() => edit(m)}>
                    Editar
                  </button>
                </td>
              </tr>
            ))}
            {modules.length === 0 && (
              <tr>
                <td colSpan={6}>Os módulos oficiais ainda não existem no catálogo (aplique a migration de fechamento comercial).</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
