import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtDateTimeSP } from "../../../lib/dates";
import { Badge } from "../MasterBits";
import { whatsappMasterApi } from "./whatsappMasterApi";
import { TOKEN_STATE_LABEL, TOKEN_STATE_TONE, needsReconnect, type TokenHealthRow } from "./whatsappMasterLogic";

export function TokenHealthSection() {
  const [rows, setRows] = useState<TokenHealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await whatsappMasterApi.tokenHealth();
    setRows(r.error ? null : r.data);
    setError(r.error);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mst-card" aria-labelledby="wa-tok-title">
      <div className="mst-head">
        <h3 id="wa-tok-title">Saúde dos tokens por empresa</h3>
        <button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      <p className="mst-sub">Conexões ativas. O token e a referência do cofre nunca são exibidos; “Sem prazo conhecido” não bloqueia nem avisa.</p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!error && rows === null && <p>Carregando…</p>}
      {rows && rows.length === 0 && <p className="mst-sub">Nenhuma conexão ativa de WhatsApp.</p>}
      {rows && rows.length > 0 && <TokenHealthTable rows={rows} />}
    </section>
  );
}

export function TokenHealthTable({ rows }: { rows: TokenHealthRow[] }) {
  return (
        <div className="mst-scroll">
          <table className="mst-table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Modo</th>
                <th>Estado do token</th>
                <th>Vencimento</th>
                <th>Última checagem</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.connectionId}>
                  <td>
                    <Link to={`/master/empresas/${r.companyId}`}>{r.companyName}</Link>
                  </td>
                  <td>{r.mode === "live" ? "Produção" : "Teste"}</td>
                  <td>
                    <Badge tone={TOKEN_STATE_TONE[r.state]}>{TOKEN_STATE_LABEL[r.state]}</Badge>
                    {r.lastErrorCode ? <small style={{ display: "block", color: "var(--text-muted)" }}>Último erro: {r.lastErrorCode}</small> : null}
                  </td>
                  <td>{r.tokenExpiresAt ? fmtDateTimeSP(r.tokenExpiresAt) : "—"}</td>
                  <td>{r.tokenCheckedAt ? fmtDateTimeSP(r.tokenCheckedAt) : "—"}</td>
                  <td>{needsReconnect(r.state) ? <strong>Pedir para reconectar o WhatsApp</strong> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
}
