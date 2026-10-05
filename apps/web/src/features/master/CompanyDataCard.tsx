import { useEffect, useState, type FormEvent } from "react";
import { fmtDateOnly } from "../../lib/dates";
import { getCompanyContact, updateCompany, type CompanyContact } from "./commercialApi";
import { fmtDocument } from "./masterLogic";

interface Props {
  company: { id: string; name: string; slug: string; document: string | null; created_at: string };
  memberCount: number;
  onChanged: () => void;
}

const fmtPhone = (v: string | null): string => {
  if (!v) return "—";
  const d = v.replace(/\D/g, "");
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return v;
};

// Dados cadastrais da empresa + edição pelo Master. Só nome, documento, telefone, WhatsApp e e-mail:
// id, slug, código de acesso e dados operacionais nunca passam por aqui (a RPC também não os altera).
export function CompanyDataCard({ company, memberCount, onChanged }: Props) {
  const [contact, setContact] = useState<CompanyContact | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", document: "", phone: "", whatsapp: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getCompanyContact(company.id);
      if (cancelled) return;
      setContact(r.data);
      if (r.error) setError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [company.id, version]);

  function startEdit() {
    setError(null);
    setForm({
      name: company.name,
      document: fmtDocument(company.document) === "—" ? "" : fmtDocument(company.document),
      phone: contact?.phone ?? "",
      whatsapp: contact?.whatsapp ?? "",
      email: contact?.email ?? "",
    });
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const r = await updateCompany(company.id, form);
    setSaving(false);
    if (r.error) return setError(r.error);
    setEditing(false);
    setVersion((v) => v + 1);
    onChanged();
  }

  return (
    <section className="mst-card">
      <h3>Dados da empresa</h3>
      {error && <div className="form-error">{error}</div>}
      {editing ? (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="cd-name">Nome</label>
            <input id="cd-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cd-doc">Documento (CPF/CNPJ)</label>
            <input id="cd-doc" value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cd-phone">Telefone</label>
            <input id="cd-phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cd-wa">WhatsApp</label>
            <input id="cd-wa" inputMode="tel" value={form.whatsapp} onChange={(e) => setForm({ ...form, whatsapp: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="cd-email">E-mail</label>
            <input id="cd-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="mst-actions">
            <button className="btn-primary" type="submit" disabled={saving} style={{ width: "auto" }}>
              {saving ? "Salvando…" : "Salvar dados"}
            </button>
            <button className="btn-secondary" type="button" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="mst-dl">
            <dt>Nome</dt>
            <dd>{company.name}</dd>
            <dt>Documento</dt>
            <dd>{fmtDocument(company.document)}</dd>
            <dt>Telefone</dt>
            <dd>{fmtPhone(contact?.phone ?? null)}</dd>
            <dt>WhatsApp</dt>
            <dd>{fmtPhone(contact?.whatsapp ?? null)}</dd>
            <dt>E-mail</dt>
            <dd>{contact?.email ?? "—"}</dd>
            <dt>Criada em</dt>
            <dd>{fmtDateOnly(company.created_at)}</dd>
            <dt>Usuários</dt>
            <dd>{memberCount}</dd>
          </dl>
          <div className="mst-actions">
            <button className="btn-secondary" type="button" onClick={startEdit}>
              Editar empresa
            </button>
          </div>
        </>
      )}
    </section>
  );
}
