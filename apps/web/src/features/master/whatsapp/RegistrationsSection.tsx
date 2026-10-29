import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDateTimeSP } from "../../../lib/dates";
import { Modal } from "../../employees/Modal";
import { Badge } from "../MasterBits";
import { whatsappMasterApi } from "./whatsappMasterApi";
import {
  EMPTY_RESOLVE_FORM,
  EVIDENCE_LABEL,
  EVIDENCE_MAX,
  EVIDENCE_TYPES,
  OUTCOME_LABEL,
  REASON_MAX,
  REGISTRATION_STATE_LABEL,
  maskId,
  resolveGate,
  validateResolveForm,
  type EvidenceType,
  type Outcome,
  type RegistrationRow,
  type ResolveForm,
} from "./whatsappMasterLogic";

export function RegistrationsSection() {
  const [rows, setRows] = useState<RegistrationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<RegistrationRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setLoading(true);
    const r = await whatsappMasterApi.registrations();
    setRows(r.error ? null : r.data);
    setError(r.error);
    setNow(new Date());
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mst-card" aria-labelledby="wa-reg-title">
      <div className="mst-head">
        <h3 id="wa-reg-title">Registros de número incertos</h3>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      <p className="mst-sub">
        Registros cujo resultado na Meta não foi confirmado. Resolver aqui só <strong>registra a conferência humana</strong>: o sistema nunca repete o registro na Meta.
        PIN e token não são exibidos.
      </p>
      {notice && (
        <div className="form-success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!error && rows === null && <p>Carregando…</p>}
      {rows && rows.length === 0 && <p className="mst-sub">Nenhum registro incerto ou em andamento.</p>}
      {rows && rows.length > 0 && <RegistrationsTable rows={rows} now={now} onResolve={setTarget} />}
      {target && (
        <ResolveDialog
          row={target}
          onClose={() => setTarget(null)}
          onDone={async () => {
            setNotice(`Registro de ${target.companyName} resolvido e auditado.`);
            setTarget(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

export function RegistrationsTable({ rows, now, onResolve }: { rows: RegistrationRow[]; now: Date; onResolve: (r: RegistrationRow) => void }) {
  return (
  <div className="mst-scroll">
    <table className="mst-table">
      <thead>
        <tr>
          <th>Empresa</th>
          <th>Número (ID Meta)</th>
          <th>Estado</th>
          <th>Último erro</th>
          <th>Última tentativa</th>
          <th>Token retido</th>
          <th>Ação</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const gate = resolveGate(r, now);
          return (
            <tr key={r.registrationId}>
              <td>
                <Link to={`/master/empresas/${r.companyId}`}>{r.companyName}</Link>
              </td>
              <td>{maskId(r.phoneNumberId)}</td>
              <td>
                <Badge tone={r.state === "uncertain" ? "warn" : "muted"}>{REGISTRATION_STATE_LABEL[r.state]}</Badge>
              </td>
              <td>{r.lastErrorCode ?? r.lastAttempt?.metaCode ?? "—"}</td>
              <td>
                {r.lastAttempt ? `${fmtDateTimeSP(r.lastAttempt.startedAt)} (${r.lastAttempt.status ?? "—"})` : "—"}
                <small style={{ display: "block", color: "var(--text-muted)" }}>{r.attemptsTotal} tentativa(s)</small>
              </td>
              <td>{r.tokenRetained ? "Sim (preservado até a resolução)" : "Não"}</td>
              <td>
                <button type="button" className="btn-primary" disabled={!gate.allowed} onClick={() => onResolve(r)} aria-describedby={gate.allowed ? undefined : `wa-gate-${r.registrationId}`}>
                  Resolver…
                </button>
                {!gate.allowed && (
                  <small id={`wa-gate-${r.registrationId}`} style={{ display: "block", color: "var(--text-muted)", maxWidth: 260 }}>
                    {gate.reason}
                    {gate.availableAt ? ` (a partir de ${fmtDateTimeSP(gate.availableAt.toISOString())})` : ""}
                  </small>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
  );
}

export function ResolveDialog({ row, onClose, onDone }: { row: RegistrationRow; onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const errors = validateResolveForm(form);
  const gate = resolveGate(row, new Date());

  async function submit() {
    setTouched(true);
    if (errors.length > 0 || busy || !gate.allowed || !form.outcome || !form.evidenceType) return;
    setBusy(true);
    setError(null);
    const r = await whatsappMasterApi.resolveRegistration({
      registrationId: row.registrationId,
      outcome: form.outcome,
      evidenceType: form.evidenceType,
      reason: form.reason,
      evidence: form.evidence,
    });
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    await onDone();
  }

  return (
    <Modal title={`Resolver registro — ${row.companyName}`} onClose={busy ? () => undefined : onClose}>
      <p>
        Número {maskId(row.phoneNumberId)} · estado atual: <strong>{REGISTRATION_STATE_LABEL[row.state]}</strong>. Confira primeiro na Meta; esta ação não chama a Meta.
      </p>
      {!gate.allowed && <div className="form-error">{gate.reason}</div>}
      <label htmlFor="wa-res-outcome">Estado de destino</label>
      <select id="wa-res-outcome" value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value as Outcome | "" })}>
        <option value="">Selecione…</option>
        {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
          <option key={o} value={o}>
            {OUTCOME_LABEL[o]}
          </option>
        ))}
      </select>
      <label htmlFor="wa-res-type">Tipo de evidência</label>
      <select id="wa-res-type" value={form.evidenceType} onChange={(e) => setForm({ ...form, evidenceType: e.target.value as EvidenceType | "" })}>
        <option value="">Selecione…</option>
        {EVIDENCE_TYPES.map((t) => (
          <option key={t} value={t}>
            {EVIDENCE_LABEL[t]}
          </option>
        ))}
      </select>
      <label htmlFor="wa-res-reason">Motivo</label>
      <textarea id="wa-res-reason" rows={2} maxLength={REASON_MAX} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      <label htmlFor="wa-res-evid">Descrição ou referência da evidência</label>
      <textarea id="wa-res-evid" rows={3} maxLength={EVIDENCE_MAX} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} />
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}>
        <input type="checkbox" checked={form.confirmed} onChange={(e) => setForm({ ...form, confirmed: e.target.checked })} />
        Conferi o estado do número diretamente na Meta e assumo a responsabilidade por esta resolução.
      </label>
      {touched && errors.length > 0 && (
        <ul className="form-error" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="mst-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className="btn-primary" disabled={busy || !gate.allowed} onClick={() => void submit()}>
          {busy ? "Resolvendo…" : "Resolver registro"}
        </button>
      </div>
    </Modal>
  );
}
