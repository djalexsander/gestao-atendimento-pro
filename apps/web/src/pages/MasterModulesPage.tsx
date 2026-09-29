import { useEffect, useState, type FormEvent } from "react";
import { listModules, saveModule } from "../features/master/catalogApi";
import { formatCents, parseCents } from "../lib/money";
import type { CatalogModule } from "../lib/types";

interface FormState {
  id: string | null;
  code: string;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
}

const EMPTY: FormState = { id: null, code: "", name: "", description: "", price: "", isActive: true };

export function MasterModulesPage() {
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listModules();
      if (cancelled) return;
      setModules(result.data);
      setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  function edit(m: CatalogModule) {
    setError(null);
    setForm({
      id: m.id,
      code: m.code,
      name: m.name,
      description: m.description ?? "",
      price: (m.monthlyPriceCents / 100).toFixed(2).replace(".", ","),
      isActive: m.isActive,
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
    setError(null);
    setSaving(true);
    const { error } = await saveModule({
      id: form.id,
      code: form.code,
      name: form.name,
      description: form.description,
      monthlyPriceCents: cents,
      isActive: form.isActive,
    });
    setSaving(false);
    if (error) {
      setError(error);
      return;
    }
    setForm(null);
    setReloadKey((k) => k + 1);
  }

  if (loading) return <p>Carregando módulos…</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Módulos</h2>
        {!form && (
          <button className="btn-secondary" type="button" onClick={() => setForm({ ...EMPTY })}>
            Novo módulo
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
        Módulos opcionais do Gestão Atendimento Pro que uma empresa poderá contratar. O código é a chave
        de permissão e não pode ser alterado depois de criado.
      </p>

      {error && <div className="form-error">{error}</div>}

      {form && (
        <form onSubmit={submit} style={{ maxWidth: 460, marginBottom: 32 }}>
          <h3 style={{ fontSize: 18 }}>{form.id ? "Editar módulo" : "Novo módulo"}</h3>
          <div className="field">
            <label htmlFor="mod-code">Código</label>
            <input
              id="mod-code"
              required
              disabled={form.id !== null}
              placeholder="ex.: whatsapp"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="mod-name">Nome</label>
            <input
              id="mod-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="mod-desc">Descrição</label>
            <input
              id="mod-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="mod-price">Preço mensal (R$)</label>
            <input
              id="mod-price"
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

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "8px 4px" }}>Código</th>
            <th style={{ padding: "8px 4px" }}>Nome</th>
            <th style={{ padding: "8px 4px" }}>Preço mensal</th>
            <th style={{ padding: "8px 4px" }}>Status</th>
            <th style={{ padding: "8px 4px" }} />
          </tr>
        </thead>
        <tbody>
          {modules.map((m) => (
            <tr key={m.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "8px 4px" }}>{m.code}</td>
              <td style={{ padding: "8px 4px" }}>{m.name}</td>
              <td style={{ padding: "8px 4px" }}>{formatCents(m.monthlyPriceCents)}</td>
              <td style={{ padding: "8px 4px" }}>{m.isActive ? "Ativo" : "Inativo"}</td>
              <td style={{ padding: "8px 4px" }}>
                <button className="btn-secondary" type="button" onClick={() => edit(m)}>
                  Editar
                </button>
              </td>
            </tr>
          ))}
          {modules.length === 0 && (
            <tr>
              <td style={{ padding: "8px 4px" }} colSpan={5}>
                Nenhum módulo cadastrado ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
