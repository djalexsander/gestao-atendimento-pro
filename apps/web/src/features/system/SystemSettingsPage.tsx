import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../app/useAuth";
import { supabasePrintingSource } from "../printing/printingApi";
import { isAgentOnline } from "../printing/printingLogic";
import { supabaseSystemSettingsSource, type SystemSettingsSource } from "./systemApi";
import {
  DEFAULT_TYPE_OPTIONS,
  draftFromSettings,
  isDirty,
  maskDocument,
  maskPhone,
  SERVICE_MODE_LABEL,
  validateDraft,
  type DefaultPointType,
  type SettingsDraft,
  type SystemSettings,
} from "./systemLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

// Resumo da impressão (só leitura): impressoras prontas e agente online. Falha = sem resumo, só o link.
export type PrintSummaryLoader = (companyId: string) => Promise<string | null>;

export const loadPrintSummary: PrintSummaryLoader = async (companyId) => {
  const [config, agents] = await Promise.all([supabasePrintingSource.loadConfig(companyId), supabasePrintingSource.loadAgents(companyId)]);
  if (config.error || !config.data) return null;
  const devices = config.data.devices;
  const receipts = devices.filter((d) => d.kind === "receipt");
  const labels = devices.filter((d) => d.kind === "label");
  const online = agents.data ? agents.data.filter((a) => a.is_active && isAgentOnline(a)).length : null;
  const part = (name: string, list: typeof devices) => (list.length === 0 ? null : `${list.filter((d) => d.ready).length}/${list.length} ${name}`);
  const printers = devices.length === 0 ? "Nenhuma impressora cadastrada" : `Prontas: ${[part("cupom", receipts), part("etiquetas", labels)].filter(Boolean).join(" · ")}`;
  const agent = online === null ? "" : online > 0 ? " · agente online" : " · agente offline";
  return printers + agent;
};

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sys-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        <small className="muted">{hint}</small>
      </span>
    </label>
  );
}

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className ? `sys-card ${className}` : "sys-card"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Form({ companyId, source, printSummary }: { companyId: string; source: SystemSettingsSource; printSummary: PrintSummaryLoader }) {
  const { refreshMemberships } = useAuth();
  const [saved, setSaved] = useState<SystemSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const result = await source.load(companyId);
    if (result.error || !result.data) {
      setLoadError(result.error);
      return;
    }
    setSaved(result.data);
    setDraft(draftFromSettings(result.data));
  }, [companyId, source]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    void printSummary(companyId).then((text) => {
      if (live) setSummary(text);
    });
    return () => {
      live = false;
    };
  }, [companyId, printSummary]);

  if (loadError) {
    return (
      <div className="form-error fin-error" role="alert">
        <p>{loadError}</p>
        <button className="btn-secondary btn-auto" type="button" onClick={() => void load()}>
          Tentar novamente
        </button>
      </div>
    );
  }
  if (!saved || !draft) return <p className="op-state">Carregando…</p>;

  const savedDraft = draftFromSettings(saved);
  const dirty = isDirty(draft, savedDraft);
  const patch = (p: Partial<SettingsDraft>) => {
    setNotice(null);
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving || !draft || !saved) return;
    const checked = validateDraft(draft, saved.company.document);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setError(null);
    setNotice(null);
    setSaving(true);
    const result = await source.save(companyId, checked.payload);
    setSaving(false);
    if (result.error || !result.data) {
      setError(result.error);
      return;
    }
    setSaved(result.data);
    setDraft(draftFromSettings(result.data));
    setNotice("Configurações salvas.");
    void refreshMemberships(); // o nome da empresa aparece no topo/menu
  }

  const modeIsBoth = saved.serviceMode === "both";

  return (
    <form className="sys-form" onSubmit={handleSubmit}>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="form-notice" role="status">
          {notice}
        </div>
      )}

      <div className="sys-grid">
        <div className="sys-col">
        <Card title="Empresa">
          <div className="field">
            <label htmlFor="sys-name">Nome da empresa</label>
            <input id="sys-name" maxLength={120} autoComplete="off" value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="sys-document">CNPJ/CPF</label>
            <input id="sys-document" inputMode="numeric" autoComplete="off" placeholder="Opcional" value={draft.document} onChange={(e) => patch({ document: maskDocument(e.target.value) })} />
          </div>
          <div className="sys-row">
            <div className="field">
              <label htmlFor="sys-phone">Telefone</label>
              <input id="sys-phone" type="tel" inputMode="tel" autoComplete="off" placeholder="(00) 00000-0000" value={draft.phone} onChange={(e) => patch({ phone: maskPhone(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="sys-whatsapp">WhatsApp</label>
              <input id="sys-whatsapp" type="tel" inputMode="tel" autoComplete="off" placeholder="(00) 00000-0000" value={draft.whatsapp} onChange={(e) => patch({ whatsapp: maskPhone(e.target.value) })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="sys-email">E-mail</label>
            <input id="sys-email" type="email" autoComplete="off" maxLength={254} value={draft.email} onChange={(e) => patch({ email: e.target.value })} />
          </div>
          <p className="field-hint">
            O código de acesso dos funcionários fica em <Link to="/app/configuracoes/codigo-acesso">Código de acesso</Link>.
          </p>
        </Card>

        <Card title="Sistema">
          <dl className="sys-info">
            <div>
              <dt>Fuso horário</dt>
              <dd>{saved.timezone}</dd>
            </div>
            <div>
              <dt>Moeda</dt>
              <dd>BRL — Real brasileiro</dd>
            </div>
            <div>
              <dt>Identificador (slug)</dt>
              <dd>{saved.company.slug}</dd>
            </div>
            {saved.updatedAt && (
              <div>
                <dt>Preferências salvas</dt>
                <dd>
                  {dateTime.format(new Date(saved.updatedAt))}
                  {saved.updatedByName && <small className="muted"> · {saved.updatedByName}</small>}
                </dd>
              </div>
            )}
          </dl>
          <p className="field-hint">Fuso e moeda são fixos: o financeiro, os relatórios e as rotinas automáticas dependem deles.</p>
        </Card>
        </div>
        <div className="sys-col">
        <Card title="Atendimento">
          <Toggle
            id="sys-quick"
            label="Cadastro rápido de cliente"
            hint="Atendente e caixa podem cadastrar um cliente na hora de abrir o atendimento. Desligado, eles só buscam clientes ou digitam o nome."
            checked={draft.allowQuickCustomerCreate}
            onChange={(v) => patch({ allowQuickCustomerCreate: v })}
          />
          <Toggle
            id="sys-show-customer"
            label="Mostrar o cliente nas comandas e mesas"
            hint="Só nas listagens operacionais. O nome continua gravado e aparece no detalhe do atendimento."
            checked={draft.showCustomerOnCard}
            onChange={(v) => patch({ showCustomerOnCard: v })}
          />
          <div className="field">
            <label htmlFor="sys-default-type">Ao abrir o painel de atendimento</label>
            <select id="sys-default-type" value={draft.defaultType} disabled={!modeIsBoth} onChange={(e) => patch({ defaultType: e.target.value as DefaultPointType })}>
              {DEFAULT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Modo atual: <strong>{SERVICE_MODE_LABEL[saved.serviceMode]}</strong>.{" "}
              {modeIsBoth ? "Nenhuma opção é removida: dá para trocar o filtro na hora." : "Esta preferência só vale no modo “Comandas e mesas”."}{" "}
              <Link to="/app/configuracoes/modo-atendimento">Alterar modo de atendimento</Link>
            </span>
          </div>
        </Card>

        <Card title="Operação">
          <Toggle
            id="sys-compact"
            label="Cards compactos"
            hint="Mais comandas, mesas e atendimentos por tela. Desligado, os cards ficam mais espaçosos. Vale só para as listagens operacionais."
            checked={draft.compactCards}
            onChange={(v) => patch({ compactCards: v })}
          />
        </Card>

        <Card title="Notificações">
          <p className="field-hint">Avisos de pedidos e produção neste aparelho e por setor.</p>
          <Link className="btn-secondary btn-auto sys-link" to="/app/configuracoes/notificacoes">
            Gerenciar notificações
          </Link>
        </Card>

        <Card title="Impressão">
          <p className="field-hint">{summary ?? "Impressoras, agente de impressão e rotas de pedidos e documentos."}</p>
          <Link className="btn-secondary btn-auto sys-link" to="/app/configuracoes/impressao">
            Gerenciar impressão
          </Link>
        </Card>

        </div>
      </div>

      <div className={dirty ? "sys-savebar sys-savebar-dirty" : "sys-savebar"}>
        <span className="sys-dirty" role="status">
          {dirty ? "Alterações não salvas" : "Tudo salvo"}
        </span>
        <div className="sys-savebar-actions">
          <button
            className="btn-secondary btn-auto"
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(savedDraft);
              setError(null);
              setNotice(null);
            }}
          >
            Descartar
          </button>
          <button className="btn-primary btn-auto" type="submit" disabled={!dirty || saving}>
            {saving ? "Salvando…" : "Salvar configurações"}
          </button>
        </div>
      </div>
    </form>
  );
}

// Configurações → Sistema / Preferências (owner/admin). Reaproveita companies (nome, documento + contato) e a
// tabela 1:1 company_operational_settings (preferências); notificações e impressão só têm atalho aqui.
export function SystemSettingsPage({ source = supabaseSystemSettingsSource, printSummary = loadPrintSummary }: { source?: SystemSettingsSource; printSummary?: PrintSummaryLoader }) {
  const { activeMembership } = useAuth();
  if (!activeMembership) return null;
  const canEdit = activeMembership.role === "owner" || activeMembership.role === "admin";

  return (
    <div className="sys-page">
      <div className="page-header">
        <h2>Sistema / Preferências</h2>
      </div>
      {canEdit ? (
        <Form key={activeMembership.companyId} companyId={activeMembership.companyId} source={source} printSummary={printSummary} />
      ) : (
        <p style={{ color: "var(--text-muted)" }}>Somente donos(as) e administradores(as) podem alterar as preferências do sistema.</p>
      )}
    </div>
  );
}
