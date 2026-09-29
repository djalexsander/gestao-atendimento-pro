import { useEffect, useState, type FormEvent } from "react";
import { listModules, listPlans, savePlan } from "../features/master/catalogApi";
import { formatCents, parseCents } from "../lib/money";
import type { CatalogModule, CatalogPlan } from "../lib/types";

interface LimitRow {
  key: string;
  value: string;
  unlimited: boolean;
}

interface FormState {
  id: string | null;
  code: string;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
  limits: LimitRow[];
  moduleIds: string[];
}

const EMPTY: FormState = {
  id: null,
  code: "",
  name: "",
  description: "",
  price: "",
  isActive: true,
  limits: [],
  moduleIds: [],
};

function describeLimits(limits: Record<string, number | null>): string {
  const entries = Object.entries(limits);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k}: ${v === null ? "ilimitado" : v}`).join(", ");
}

export function MasterPlansPage() {
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [plansResult, modulesResult] = await Promise.all([listPlans(), listModules()]);
      if (cancelled) return;
      setPlans(plansResult.data);
      setModules(modulesResult.data);
      setError(plansResult.error ?? modulesResult.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function edit(p: CatalogPlan) {
    setError(null);
    setForm({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description ?? "",
      price: (p.monthlyPriceCents / 100).toFixed(2).replace(".", ","),
      isActive: p.isActive,
      limits: Object.entries(p.limits).map(([key, value]) => ({
        key,
        value: value === null ? "" : String(value),
        unlimited: value === null,
      })),
      moduleIds: p.moduleIds,
    });
  }

  function updateLimit(index: number, patch: Partial<LimitRow>) {
    if (!form) return;
    setForm({
      ...form,
      limits: form.limits.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const cents = parseCents(form.price);
    if (cents === null) {
      setError("Preço inválido. Use o formato 49,90.");
      return;
    }

    const limits: Record<string, number | null> = {};
    for (const row of form.limits) {
      const key = row.key.trim();
      if (!key) continue;
      if (key in limits) {
        setError(`Limite "${key}" repetido.`);
        return;
      }
      if (row.unlimited) {
        limits[key] = null;
      } else if (/^\d+$/.test(row.value.trim())) {
        limits[key] = Number(row.value.trim());
      } else {
        setError(`Limite "${key}": use um inteiro >= 0 ou marque "ilimitado".`);
        return;
      }
    }

    setError(null);
    setSaving(true);
    const { error } = await savePlan(
      {
        id: form.id,
        code: form.code,
        name: form.name,
        description: form.description,
        monthlyPriceCents: cents,
        isActive: form.isActive,
      },
      limits,
      form.moduleIds,
    );
    setSaving(false);
    if (error) {
      setError(error);
      return;
    }
    setForm(null);
    setReloadKey((k) => k + 1);
  }

  if (loading) return <p>Carregando planos…</p>;

  const moduleName = (id: string) => modules.find((m) => m.id === id)?.name ?? id;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Planos</h2>
        {!form && (
          <button className="btn-secondary" type="button" onClick={() => setForm({ ...EMPTY })}>
            Novo plano
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
        Planos comerciais do Gestão de Atendimento Pro. O código não pode ser alterado depois de criado.
        Limites vazios ou marcados como "ilimitado" não restringem o recurso.
      </p>

      {error && <div className="form-error">{error}</div>}

      {form && (
        <form onSubmit={submit} style={{ maxWidth: 520, marginBottom: 32 }}>
          <h3 style={{ fontSize: 18 }}>{form.id ? "Editar plano" : "Novo plano"}</h3>
          <div className="field">
            <label htmlFor="plan-code">Código</label>
            <input
              id="plan-code"
              required
              disabled={form.id !== null}
              placeholder="ex.: base"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="plan-name">Nome</label>
            <input
              id="plan-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="plan-desc">Descrição</label>
            <input
              id="plan-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="plan-price">Preço mensal (R$)</label>
            <input
              id="plan-price"
              required
              inputMode="decimal"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
            />
          </div>
          <label style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            Ativo
          </label>

          <h4 style={{ margin: "8px 0" }}>Limites incluídos</h4>
          {form.limits.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <input
                aria-label="Chave do limite"
                placeholder="ex.: max_users"
                value={row.key}
                onChange={(e) => updateLimit(i, { key: e.target.value })}
              />
              <input
                aria-label="Valor do limite"
                inputMode="numeric"
                disabled={row.unlimited}
                value={row.value}
                onChange={(e) => updateLimit(i, { value: e.target.value })}
              />
              <label style={{ whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={row.unlimited}
                  onChange={(e) => updateLimit(i, { unlimited: e.target.checked })}
                />{" "}
                ilimitado
              </label>
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setForm({ ...form, limits: form.limits.filter((_, j) => j !== i) })}
              >
                Remover
              </button>
            </div>
          ))}
          <button
            className="btn-secondary"
            type="button"
            style={{ marginBottom: 16 }}
            onClick={() =>
              setForm({ ...form, limits: [...form.limits, { key: "", value: "", unlimited: false }] })
            }
          >
            Adicionar limite
          </button>

          <h4 style={{ margin: "8px 0" }}>Módulos incluídos no plano</h4>
          {modules.length === 0 && (
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
              Nenhum módulo cadastrado ainda.
            </p>
          )}
          {modules.map((m) => (
            <label key={m.id} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={form.moduleIds.includes(m.id)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    moduleIds: e.target.checked
                      ? [...form.moduleIds, m.id]
                      : form.moduleIds.filter((id) => id !== m.id),
                  })
                }
              />
              {m.name}
              {!m.isActive && " (inativo)"}
            </label>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="btn-primary" type="submit" disabled={saving} style={{ width: "auto" }}>
              {saving ? "Salvando…" : "Salvar"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => setForm(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "8px 4px" }}>Código</th>
            <th style={{ padding: "8px 4px" }}>Nome</th>
            <th style={{ padding: "8px 4px" }}>Preço mensal</th>
            <th style={{ padding: "8px 4px" }}>Limites</th>
            <th style={{ padding: "8px 4px" }}>Módulos</th>
            <th style={{ padding: "8px 4px" }}>Status</th>
            <th style={{ padding: "8px 4px" }} />
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>{p.code}</td>
              <td style={{ padding: "8px 4px" }}>{p.name}</td>
              <td style={{ padding: "8px 4px" }}>{formatCents(p.monthlyPriceCents)}</td>
              <td style={{ padding: "8px 4px" }}>{describeLimits(p.limits)}</td>
              <td style={{ padding: "8px 4px" }}>
                {p.moduleIds.length ? p.moduleIds.map(moduleName).join(", ") : "—"}
              </td>
              <td style={{ padding: "8px 4px" }}>{p.isActive ? "Ativo" : "Inativo"}</td>
              <td style={{ padding: "8px 4px" }}>
                <button className="btn-secondary" type="button" onClick={() => edit(p)}>
                  Editar
                </button>
              </td>
            </tr>
          ))}
          {plans.length === 0 && (
            <tr>
              <td style={{ padding: "8px 4px" }} colSpan={7}>
                Nenhum plano cadastrado ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
