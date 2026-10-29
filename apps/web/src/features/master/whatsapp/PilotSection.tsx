import { useCallback, useEffect, useState } from "react";
import { fmtDateTimeSP } from "../../../lib/dates";
import { Modal } from "../../employees/Modal";
import { fetchMasterCompanies } from "../api";
import { Badge } from "../MasterBits";
import { whatsappMasterApi } from "./whatsappMasterApi";
import { PILOT_NOTE_MAX, shortUserId, validatePilotNote, type PilotEvent, type PilotRow } from "./whatsappMasterLogic";

type Pending = { company: { id: string; name: string }; authorize: boolean } | null;

export function PilotSection() {
  const [rows, setRows] = useState<PilotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [pick, setPick] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [events, setEvents] = useState<{ name: string; list: PilotEvent[]; error: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [l, a, c] = await Promise.all([whatsappMasterApi.pilotList(), whatsappMasterApi.signupAvailable(), fetchMasterCompanies()]);
    setRows(l.error ? null : l.data);
    setError(l.error);
    setAvailable(a.data);
    setCompanies(c.data.map((x) => ({ id: x.id, name: x.name })));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const authorizedIds = new Set((rows ?? []).filter((r) => r.authorized).map((r) => r.companyId));
  const candidates = companies.filter((c) => !authorizedIds.has(c.id));

  async function openEvents(r: PilotRow) {
    const res = await whatsappMasterApi.pilotEvents(r.companyId);
    setEvents({ name: r.companyName, list: res.data, error: res.error });
  }

  return (
    <section className="mst-card" aria-labelledby="wa-pilot-title">
      <div className="mst-head">
        <h3 id="wa-pilot-title">Empresas do piloto (Embedded Signup)</h3>
      </div>
      {available === false && (
        <div className="mst-banner" role="status">
          Embedded Signup DESATIVADO globalmente (embedded_signup_enabled = false).
          <span>Autorizar empresas aqui só prepara o piloto: ninguém consegue conectar enquanto a trava global estiver desligada. Esta tela não altera a trava global.</span>
        </div>
      )}
      {available === true && (
        <div className="mst-banner" role="status">
          Embedded Signup LIBERADO globalmente.
          <span>Somente as empresas autorizadas abaixo conseguem iniciar a conexão. Esta tela não altera a trava global.</span>
        </div>
      )}
      {available === null && !error && <p className="mst-sub">Verificando a trava global…</p>}
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

      <div className="mst-toolbar">
        <div>
          <label htmlFor="wa-pilot-pick">Autorizar empresa</label>
          <select id="wa-pilot-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Selecione…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!pick}
          onClick={() => {
            const c = candidates.find((x) => x.id === pick);
            if (c) setPending({ company: c, authorize: true });
          }}
        >
          Autorizar…
        </button>
      </div>

      {rows && rows.length === 0 && <p className="mst-sub">Nenhuma empresa autorizada até agora (allowlist vazia).</p>}
      {rows && rows.length > 0 && <PilotTable rows={rows} onEvents={(r) => void openEvents(r)} onToggle={(r) => setPending({ company: { id: r.companyId, name: r.companyName }, authorize: !r.authorized })} />}
      {pending && (
        <PilotConfirm
          pending={pending}
          onClose={() => setPending(null)}
          onDone={async (msg) => {
            setPending(null);
            setPick("");
            setNotice(msg);
            await load();
          }}
        />
      )}
      {events && (
        <Modal title={`Histórico — ${events.name}`} onClose={() => setEvents(null)}>
          {events.error && <div className="form-error">{events.error}</div>}
          {!events.error && events.list.length === 0 && <p>Nenhum evento registrado.</p>}
          <ul>
            {events.list.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {fmtDateTimeSP(e.at)} · {e.action === "authorized" ? "Autorizada" : "Revogada"} por {shortUserId(e.actorUserId)}
                {e.note ? ` — ${e.note}` : ""}
              </li>
            ))}
          </ul>
          <div className="mst-actions">
            <button type="button" className="btn-secondary" onClick={() => setEvents(null)}>
              Fechar
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function PilotTable({ rows, onEvents, onToggle }: { rows: PilotRow[]; onEvents: (r: PilotRow) => void; onToggle: (r: PilotRow) => void }) {
  return (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Situação</th>
                <th>Conexão ativa</th>
                <th>Último evento</th>
                <th>Nota</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.companyId}>
                  <td>{r.companyName}</td>
                  <td>
                    <Badge tone={r.authorized ? "ok" : "muted"}>{r.authorized ? "Autorizada" : "Revogada"}</Badge>
                  </td>
                  <td>{r.connectionActive ? "Sim" : "Não"}</td>
                  <td>
                    {r.authorized
                      ? `Autorizada em ${fmtDateTimeSP(r.authorizedAt)} por ${shortUserId(r.authorizedBy)}`
                      : `Revogada em ${fmtDateTimeSP(r.revokedAt)} por ${shortUserId(r.revokedBy)}`}
                  </td>
                  <td>{r.note ?? "—"}</td>
                  <td>
                    <div className="mst-actions" style={{ marginTop: 0 }}>
                      <button type="button" className="btn-secondary" onClick={() => onEvents(r)}>
                        Histórico
                      </button>
                      <button
                        type="button"
                        className={r.authorized ? "btn-danger" : "btn-primary"}
                        onClick={() => onToggle(r)}
                      >
                        {r.authorized ? "Revogar…" : "Autorizar…"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
}

export function PilotConfirm({ pending, onClose, onDone }: { pending: NonNullable<Pending>; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteError = validatePilotNote(note);
  const verb = pending.authorize ? "autorizar" : "revogar";

  async function submit() {
    if (noteError || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    const r = await whatsappMasterApi.pilotSet(pending.company.id, pending.authorize, note);
    setBusy(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    await onDone(`Empresa ${pending.company.name}: participação ${pending.authorize ? "autorizada" : "revogada"}.`);
  }

  return (
    <Modal title={pending.authorize ? "Autorizar empresa no piloto" : "Revogar autorização do piloto"} onClose={busy ? () => undefined : onClose}>
      <p>
        Você vai {verb} <strong>{pending.company.name}</strong> no piloto do Embedded Signup.
        {!pending.authorize && " Tentativas de conexão em andamento serão encerradas; a conexão já existente não é alterada."}
      </p>
      <label htmlFor="wa-pilot-note">Motivo (obrigatório, fica no histórico)</label>
      <textarea id="wa-pilot-note" rows={3} maxLength={PILOT_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
      {note !== "" && noteError && <div className="form-error">{noteError}</div>}
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "10px 0" }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        Confirmo que quero {verb} esta empresa.
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="mst-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className={pending.authorize ? "btn-primary" : "btn-danger"} disabled={busy || !!noteError || !confirmed} onClick={() => void submit()}>
          {busy ? "Salvando…" : pending.authorize ? "Autorizar" : "Revogar"}
        </button>
      </div>
    </Modal>
  );
}
