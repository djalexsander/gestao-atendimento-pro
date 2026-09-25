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
import { BillingStatus } from "../features/master/BillingStatus";
import { SubscriptionTimeline } from "../features/master/SubscriptionTimeline";
import { TrialPanel } from "../features/master/TrialPanel";
import { formatCents } from "../lib/money";
import { EVENT_LABEL, MANUAL_STATUSES, STATUS_LABEL } from "../lib/subscriptionLabels";
import type { CatalogModule, CatalogPlan, CompanyDetail, CompanyTrial, SubscriptionStatus } from "../lib/types";

const ROLE_LABEL: Record<string, string> = { owner: "Dono(a)", admin: "Administrador(a)", agent: "Agente" };
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

      <TrialPanel
        key={`trial-${loadedVersion}`}
        companyId={detail.company.id}
        trial={detail.trial}
        onChanged={() => setReloadKey((k) => k + 1)}
      />

      <h3 style={{ fontSize: 18 }}>Assinatura</h3>
      {error && <div className="form-error">{error}</div>}
      {detail.subscription ? (
        <SubscriptionPanel
          key={`panel-${loadedVersion}`}
          sub={detail.subscription}
          reservedPlanCode={detail.trial.reserved_plan_code}
          plans={plans}
          modules={modules}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      ) : (
        <SubscribeForm
          key={`form-${loadedVersion}`}
          companyId={detail.company.id}
          trial={detail.trial}
          plans={plans}
          modules={modules}
          onChanged={() => setReloadKey((k) => k + 1)}
        />
      )}

      {detail.subscription && (
        <BillingStatus key={`billing-${loadedVersion}`} subscriptionId={detail.subscription.id} />
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
  trial,
  plans,
  modules,
  onChanged,
}: {
  companyId: string;
  trial: CompanyTrial;
  plans: CatalogPlan[];
  modules: CatalogModule[];
  onChanged: () => void;
}) {
  // O registro de catálogo reservado (code do backend) é só apresentação do período grátis: o backend
  // recusa contratá-lo, então nem aparece aqui. O período grátis em si nem depende dele.
  const activePlans = plans.filter((p) => p.isActive && p.code !== trial.reserved_plan_code);
  const [planId, setPlanId] = useState(activePlans[0]?.id ?? "");
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const selectedPlan = activePlans.find((p) => p.id === planId);
  const extraCandidates = modules.filter((m) => m.isActive && !selectedPlan?.moduleIds.includes(m.id));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const result = await subscribeCompany(
      companyId,
      planId,
      extraIds.filter((id) => extraCandidates.some((m) => m.id === id)),
    );
    setSaving(false);
    if (result.error) return setError(result.error);
    onChanged();
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 420 }}>
      <p style={{ color: "var(--text-muted)" }}>
        Esta empresa não tem assinatura paga e continua operando normalmente.
      </p>
      {trial.state === "trialing" && (
        <p>
          Há um <strong>período grátis em andamento</strong>: contratar um plano pago o encerra agora (convertido; os
          dias restantes não continuam valendo) e gera a cobrança inicial hoje. A assinatura fica aguardando o
          pagamento inicial.
        </p>
      )}
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
          {extraCandidates.length > 0 && (
            <div className="field">
              <label>Módulos adicionais (entram na cobrança inicial)</label>
              {extraCandidates.map((m) => (
                <label key={m.id} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={extraIds.includes(m.id)}
                    onChange={(e) =>
                      setExtraIds(e.target.checked ? [...extraIds, m.id] : extraIds.filter((x) => x !== m.id))
                    }
                  />
                  {m.name} — {formatCents(m.monthlyPriceCents)}
                </label>
              ))}
            </div>
          )}
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Ao contratar, a assinatura nasce <strong>aguardando pagamento inicial</strong> e é criada na hora a
            cobrança inicial integral (plano + adicionais, sem prorrata), com vencimento hoje. O dia de vencimento das
            mensalidades é o dia desta contratação paga (não se escolhe aqui): a próxima vence no mesmo dia do mês
            seguinte (dia inexistente usa o último dia do mês). A assinatura só fica ativa quando a fatura inicial for
            paga.
          </p>
          <button className="btn-primary" type="submit" disabled={saving} style={{ width: "auto" }}>
            {saving ? "Contratando…" : "Contratar plano pago"}
          </button>
        </>
      )}
    </form>
  );
}

function SubscriptionPanel({
  sub,
  reservedPlanCode,
  plans,
  modules,
  onChanged,
}: {
  sub: NonNullable<CompanyDetail["subscription"]>;
  reservedPlanCode: string;
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
  // O registro reservado do período grátis não vira assinatura (o backend recusa a troca para ele).
  const switchablePlans = plans.filter((p) => p.isActive && p.id !== sub.plan.id && p.code !== reservedPlanCode);
  // Contrato cobrado CONGELADO (decisão do banco): enquanto a fatura inicial não for paga, plano, módulos e dia
  // de vencimento não mudam e a assinatura não é ativada manualmente; restam suspender e cancelar.
  const locked = sub.status !== "canceled" && !sub.initial_charge_settled;
  const statusOptions = locked ? MANUAL_STATUSES.filter((s) => s === "suspended" || s === "canceled") : MANUAL_STATUSES;

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
        todo dia {sub.billing_day} (dia da contratação paga) · Contratada na competência{" "}
        {fmtDate(sub.current_period_start)} a {fmtDate(sub.current_period_end)} (informativo)
        {sub.grace_until && ` · Carência até ${fmtDate(sub.grace_until)}`}
      </p>
      {sub.status === "pending_payment" && (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          Aguardando o pagamento da fatura inicial: a assinatura só é ativada por esse pagamento (não há ativação
          manual).
        </p>
      )}
      {locked && (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          Contrato cobrado congelado: enquanto a fatura inicial não for paga, plano, módulos adicionais e dia de
          vencimento não podem ser alterados. Pague a fatura inicial ou cancele a assinatura e contrate de novo.
        </p>
      )}
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
              disabled={locked}
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
        disabled={busy || locked}
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
              <select id="chg-plan" value={newPlanId} disabled={locked} onChange={(e) => setNewPlanId(e.target.value)}>
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
                disabled={busy || locked || !newPlanId}
                onClick={() => run(() => changePlan(sub.id, newPlanId))}
              >
                Trocar
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="chg-day">Ajuste excepcional do dia de vencimento (1 a 31)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="chg-day" inputMode="numeric" value={day} disabled={locked} onChange={(e) => setDay(e.target.value)} />
              <button
                className="btn-secondary"
                type="button"
                disabled={busy || locked}
                onClick={() => run(() => setBillingDay(sub.id, Number(day)))}
              >
                Alterar
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              O dia nasce da contratação paga e não muda sozinho. Este ajuste é uma exceção do Master: vale a partir da
              primeira competência ainda não faturada, não altera faturas já geradas nem a cobrança inicial, e fica
              registrado no histórico com o autor.
            </p>
          </div>

          <div>
            <label htmlFor="chg-status">Status (alteração manual)</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                id="chg-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
              >
                {!statusOptions.includes(sub.status) && (
                  <option value={sub.status} disabled>
                    {STATUS_LABEL[sub.status]} (atual)
                  </option>
                )}
                {statusOptions.map((s) => (
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
                {locked &&
                  " Como ela nunca foi ativada, a cobrança inicial em aberto ou vencida é anulada automaticamente (fica no histórico como anulada por cancelamento antes da ativação); nenhuma outra fatura é alterada."}
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
