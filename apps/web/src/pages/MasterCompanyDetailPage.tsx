import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { listModules, listPlans } from "../features/master/catalogApi";
import {
  changePlan,
  getCompanyDetail,
  setBillingDay,
  setSubscriptionModules,
  setSubscriptionStatus,
  subscribeCompany,
} from "../features/master/subscriptionApi";
import { CompanyInvoices } from "../features/master/CompanyInvoices";
import { SubscriptionTimeline } from "../features/master/SubscriptionTimeline";
import { formatCents } from "../lib/money";
import { EVENT_LABEL, STATUS_LABEL } from "../lib/subscriptionLabels";
import type { CatalogModule, CatalogPlan, CompanyDetail, SubscriptionStatus } from "../lib/types";

const ROLE_LABEL: Record<string, string> = { owner: "Dono(a)", admin: "Administrador(a)", agent: "Agente" };
const STATUSES = Object.keys(STATUS_LABEL) as SubscriptionStatus[];
const cell = { padding: "8px 4px" } as const;

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
}

export function MasterCompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Contador de dados carregados: as chaves dos painéis usam ele (e não reloadKey)
  // para remontar só quando o detalhe novo chegou, evitando estado inicial obsoleto.
  const [loadedVersion, setLoadedVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const [d, p, m] = await Promise.all([getCompanyDetail(id), listPlans(), listModules()]);
      if (cancelled) return;
      setDetail(d.data);
      setPlans(p.data);
      setModules(m.data);
      setError(d.error ?? p.error ?? m.error);
      setLoading(false);
      setLoadedVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (loading) return <p>Carregando empresa…</p>;
  if (error || !detail) return <div className="form-error">{error ?? "Empresa não encontrada."}</div>;

  return (
    <div>
      <p>
        <Link to="/master/empresas">← Empresas</Link>
      </p>
      <h2>{detail.company.name}</h2>

      <h3 style={{ fontSize: 18 }}>Dados da empresa</h3>
      <p style={{ color: "var(--text-muted)" }}>
        Documento: {detail.company.document ?? "—"} · Slug: {detail.company.slug} · Criada em{" "}
        {fmtDate(detail.company.created_at)}
      </p>

      <h3 style={{ fontSize: 18 }}>Membros ({detail.members.length})</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
        <tbody>
          {detail.members.map((m) => (
            <tr key={m.user_id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={cell}>{m.full_name ?? "—"}</td>
              <td style={cell}>{m.email ?? "—"}</td>
              <td style={cell}>{ROLE_LABEL[m.role] ?? m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: 18 }}>Assinatura</h3>
      {error && <div className="form-error">{error}</div>}
      {detail.subscription ? (
        <SubscriptionPanel
          key={`panel-${loadedVersion}`}
          sub={detail.subscription}
          plans={plans}
          modules={modules}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      ) : (
        <SubscribeForm
          key={`form-${loadedVersion}`}
          companyId={detail.company.id}
          plans={plans}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}

      {detail.subscription && (
        <SubscriptionTimeline key={`timeline-${loadedVersion}`} subscriptionId={detail.subscription.id} />
      )}

      <CompanyInvoices
        key={`invoices-${loadedVersion}`}
        companyId={detail.company.id}
        subscriptionId={detail.subscription?.id ?? null}
      />

      {detail.past_subscriptions.length > 0 && (
        <>
          <h3 style={{ fontSize: 18, marginTop: 24 }}>Assinaturas anteriores</h3>
          <ul>
            {detail.past_subscriptions.map((s) => (
              <li key={s.id}>
                {s.plan_name} — {formatCents(s.price_cents_snapshot)} — {fmtDate(s.started_at)} até{" "}
                {fmtDate(s.canceled_at)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SubscribeForm({
  companyId,
  plans,
  onChanged,
}: {
  companyId: string;
  plans: CatalogPlan[];
  onChanged: () => void;
}) {
  const activePlans = plans.filter((p) => p.isActive);
  const [planId, setPlanId] = useState(activePlans[0]?.id ?? "");
  const [billingDay, setBillingDayValue] = useState("10");
  const [status, setStatus] = useState<"trialing" | "active">("active");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const day = Number(billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setError("Dia de vencimento deve ser um inteiro de 1 a 31.");
      return;
    }
    setError(null);
    setSaving(true);
    const result = await subscribeCompany(companyId, planId, day, status);
    setSaving(false);
    if (result.error) return setError(result.error);
    onChanged();
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 420 }}>
      <p style={{ color: "var(--text-muted)" }}>
        Esta empresa não tem assinatura e continua operando normalmente.
      </p>
      {error && <div className="form-error">{error}</div>}
      {activePlans.length === 0 ? (
        <p>Nenhum plano ativo no catálogo. Cadastre um em Planos.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="sub-plan">Plano</label>
            <select id="sub-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {activePlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatCents(p.monthlyPriceCents)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sub-day">Dia de vencimento (1 a 31)</label>
            <input
              id="sub-day"
              inputMode="numeric"
              value={billingDay}
              onChange={(e) => setBillingDayValue(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-status">Status inicial</label>
            <select
              id="sub-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as "trialing" | "active")}
            >
              <option value="active">Ativa</option>
              <option value="trialing">Em teste</option>
            </select>
          </div>
          <button className="btn-primary" type="submit" disabled={saving} style={{ width: "auto" }}>
            {saving ? "Contratando…" : "Contratar plano"}
          </button>
        </>
      )}
    </form>
  );
}

function SubscriptionPanel({
  sub,
  plans,
  modules,
  onChanged,
}: {
  sub: NonNullable<CompanyDetail["subscription"]>;
  plans: CatalogPlan[];
  modules: CatalogModule[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPlanId, setNewPlanId] = useState("");
  const [status, setStatus] = useState<SubscriptionStatus>(sub.status);
  const [graceUntil, setGraceUntil] = useState(sub.grace_until ?? "");
  const [day, setDay] = useState(String(sub.billing_day));
  const [extraIds, setExtraIds] = useState<string[]>(sub.extra_modules.map((e) => e.module_id));

  const includedIds = sub.included_modules.map((m) => m.id);
  const currentExtraIds = sub.extra_modules.map((e) => e.module_id);
  const candidates = modules.filter(
    (m) => !includedIds.includes(m.id) && (m.isActive || currentExtraIds.includes(m.id)),
  );
  const switchablePlans = plans.filter((p) => p.isActive && p.id !== sub.plan.id);

  async function run(action: () => Promise<{ error: string | null }>) {
    setError(null);
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result.error) return setError(result.error);
    onChanged();
  }

  const extrasTotal = sub.extra_modules.reduce((sum, e) => sum + e.price_cents_snapshot, 0);

  return (
    <div>
      {error && <div className="form-error">{error}</div>}

      <p>
        <strong>{STATUS_LABEL[sub.status]}</strong> · Plano <strong>{sub.plan.name}</strong> · Vence
        todo dia {sub.billing_day} · Contratada na competência {fmtDate(sub.current_period_start)} a{" "}
        {fmtDate(sub.current_period_end)} (informativo)
        {sub.grace_until && ` · Carência até ${fmtDate(sub.grace_until)}`}
      </p>
      <p>
        Preço contratado do plano: <strong>{formatCents(sub.plan.price_cents_snapshot)}</strong>
        {sub.plan.price_cents_snapshot !== sub.plan.catalog_price_cents &&
          ` (catálogo hoje: ${formatCents(sub.plan.catalog_price_cents)})`}
        {" · "}Extras: {formatCents(extrasTotal)}
      </p>

      <h4>Módulos incluídos no plano contratado</h4>
      <p>{sub.included_modules.length ? sub.included_modules.map((m) => m.name).join(", ") : "—"}</p>

      <h4>Módulos adicionais</h4>
      {candidates.length === 0 && <p style={{ color: "var(--text-muted)" }}>Nenhum módulo disponível.</p>}
      {candidates.map((m) => {
        const contracted = sub.extra_modules.find((e) => e.module_id === m.id);
        return (
          <label key={m.id} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={extraIds.includes(m.id)}
              onChange={(e) =>
                setExtraIds(e.target.checked ? [...extraIds, m.id] : extraIds.filter((x) => x !== m.id))
              }
            />
            {m.name} —{" "}
            {contracted
              ? `contratado por ${formatCents(contracted.price_cents_snapshot)}`
              : formatCents(m.monthlyPriceCents)}
            {!m.isActive && " (inativo)"}
          </label>
        );
      })}
      <button
        className="btn-secondary"
        type="button"
        disabled={busy}
        style={{ margin: "8px 0 16px" }}
        onClick={() => run(() => setSubscriptionModules(sub.id, extraIds))}
      >
        Salvar módulos adicionais
      </button>

      {sub.status !== "canceled" && (
        <div style={{ display: "grid", gap: 16, maxWidth: 460 }}>
          <div>
            <label htmlFor="chg-plan">Trocar plano</label>
            <div style={{ display: "flex", gap: 8 }}>
              <select id="chg-plan" value={newPlanId} onChange={(e) => setNewPlanId(e.target.value)}>
                <option value="">Selecione…</option>
                {switchablePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatCents(p.monthlyPriceCents)}
                  </option>
                ))}
              </select>
              <button
                className="btn-secondary"
                type="button"
                disabled={busy || !newPlanId}
                onClick={() => run(() => changePlan(sub.id, newPlanId))}
              >
                Trocar
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="chg-day">Dia de vencimento (1 a 31)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="chg-day" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} />
              <button
                className="btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => run(() => setBillingDay(sub.id, Number(day)))}
              >
                Alterar
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="chg-status">Status (alteração manual)</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                id="chg-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              {status === "grace" && (
                <input
                  type="date"
                  aria-label="Carência até"
                  value={graceUntil}
                  onChange={(e) => setGraceUntil(e.target.value)}
                />
              )}
              <button
                className="btn-secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() =>
                    setSubscriptionStatus(sub.id, status, status === "grace" && graceUntil ? graceUntil : null),
                  )
                }
              >
                Aplicar
              </button>
            </div>
            {status === "canceled" && (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                Cancelar é definitivo para esta assinatura (o histórico é mantido).
              </p>
            )}
          </div>
        </div>
      )}

      <h4 style={{ marginTop: 24 }}>Composição de módulos (histórico)</h4>
      <ul style={{ paddingLeft: 18 }}>
        {sub.module_history.map((h) => (
          <li key={h.id}>
            {h.name} — {h.source === "plan" ? "incluído no plano" : "extra " + formatCents(h.price_cents_snapshot)} —{" "}
            {fmtDate(h.added_at)} até {h.removed_at ? fmtDate(h.removed_at) : "hoje"}
          </li>
        ))}
        {sub.module_history.length === 0 && <li>—</li>}
      </ul>

      <h4 style={{ marginTop: 24 }}>Histórico</h4>
      <ul style={{ paddingLeft: 18 }}>
        {sub.events.map((e) => (
          <li key={e.id} style={{ marginBottom: 4 }}>
            <strong>{EVENT_LABEL[e.event_type] ?? e.event_type}</strong> —{" "}
            {new Date(e.created_at).toLocaleString("pt-BR")}
            {e.actor_email && ` — ${e.actor_email}`}
            <br />
            <code style={{ fontSize: 12 }}>{JSON.stringify(e.payload)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
