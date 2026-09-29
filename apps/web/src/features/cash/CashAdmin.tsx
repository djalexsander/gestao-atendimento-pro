import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { formatReais } from "../../lib/money";
import { supabaseCashSource, type CashSession, type CashSource } from "./cashApi";
import { CloseCashDialog, OpenCashDialog } from "./CashDialogs";
import { notifyCashChanged } from "./useMyOpenCash";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, summarizeMovements, type CashMovementRow } from "./cashLogic";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const fmt = (iso: string) => dateTime.format(new Date(iso));

// Financeiro > Caixa (primeira tela): lista os caixas, mostra o resumo por forma de pagamento e os
// movimentos do caixa selecionado; abre/fecha o caixa do próprio usuário. Só leitura de dinheiro:
// tudo que grava passa pelas RPCs. RLS: owner/admin veem todos os caixas da empresa.
export function CashAdmin({ source = supabaseCashSource }: { source?: CashSource }) {
  const { activeMembership, user, profile } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const userId = user?.id ?? null;

  const [sessions, setSessions] = useState<CashSession[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Movimentos JÁ carregados e de QUAL caixa são: o resumo só usa se forem do caixa selecionado.
  const [loaded, setLoaded] = useState<{ cashId: string; rows: CashMovementRow[] } | null>(null);
  // Movimentos do PRÓPRIO caixa, carregados ao abrir o fechamento (independe da seleção da lista).
  const [ownMovements, setOwnMovements] = useState<CashMovementRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"open" | "close" | "close-other" | null>(null);
  const role = activeMembership?.role ?? null;
  const canAdminClose = role === "owner" || role === "admin";

  const reload = useCallback(async () => {
    if (!companyId) return;
    const result = await source.listCashSessions(companyId);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar o caixa.");
      return;
    }
    setLoadError(null);
    setSessions(result.data);
    setSelectedId((current) => current ?? result.data?.find((s) => s.status === "open")?.id ?? result.data?.[0]?.id ?? null);
  }, [companyId, source]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void source.listMovements(selectedId).then((result) => {
      if (!cancelled && result.data) setLoaded({ cashId: selectedId, rows: result.data });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, source, sessions]);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;
  const myOpen = sessions?.find((s) => s.status === "open" && s.openedBy === userId) ?? null;
  // null = os movimentos do caixa selecionado ainda não chegaram (nunca mostra os de outro caixa).
  const movements = loaded && loaded.cashId === selectedId ? loaded.rows : null;
  const summary = summarizeMovements(movements ?? []);

  // Owner/admin podem encerrar o caixa aberto de OUTRO operador (o servidor confirma o papel).
  const canCloseSelected =
    canAdminClose && selected !== null && selected.status === "open" && selected.openedBy !== userId && movements !== null;

  async function startClose() {
    if (!myOpen) return;
    const result = await source.listMovements(myOpen.id);
    setOwnMovements(result.data ?? []);
    setDialog("close");
  }

  return (
    <div>
      <div className="page-header">
        <h2>Caixa</h2>
        {myOpen ? (
          <button className="btn-danger" type="button" onClick={() => void startClose()}>
            Fechar meu caixa
          </button>
        ) : (
          <button className="btn-primary btn-auto" type="button" onClick={() => setDialog("open")}>
            Abrir caixa
          </button>
        )}
      </div>

      {loadError && <div className="form-error">{loadError}</div>}
      {!sessions && !loadError && <p className="op-state">Carregando…</p>}
      {sessions && sessions.length === 0 && <p className="field-hint">Nenhum caixa aberto até agora.</p>}

      {sessions && sessions.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Operador</th>
                <th>Abertura</th>
                <th>Saldo inicial</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.openedByName ?? "—"}</td>
                  <td>{fmt(s.openedAt)}</td>
                  <td>{formatReais(s.openingAmount)}</td>
                  <td>
                    <span className={s.status === "open" ? "status-badge status-active" : "status-badge status-inactive"}>
                      {s.status === "open" ? "Aberto" : `Fechado ${s.closedAt ? fmt(s.closedAt) : ""}`}
                    </span>
                  </td>
                  <td>
                    <button className="btn-secondary btn-small" type="button" onClick={() => setSelectedId(s.id)}>
                      {s.id === selectedId ? "Selecionado" : "Ver movimentos"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <section>
          <h3>
            Caixa de {selected.openedByName ?? "—"} · {fmt(selected.openedAt)}
          </h3>
          {selected.closingNotes && <p className="field-hint">Observação: {selected.closingNotes}</p>}
          {canCloseSelected && (
            <button className="btn-danger" type="button" onClick={() => setDialog("close-other")}>
              Fechar caixa do operador
            </button>
          )}
          <dl className="cash-summary">
            <div>
              <dt>Saldo inicial</dt>
              <dd>{formatReais(selected.openingAmount)}</dd>
            </div>
            {PAYMENT_METHODS.map((method) => (
              <div key={method}>
                <dt>Vendas — {PAYMENT_METHOD_LABEL[method]}</dt>
                <dd>{movements === null ? "…" : formatReais(summary.byMethod[method])}</dd>
              </div>
            ))}
            <div>
              <dt>Total vendido</dt>
              <dd>{movements === null ? "…" : formatReais(summary.total)}</dd>
            </div>
          </dl>

          <h4>Movimentos</h4>
          {movements === null ? (
            <p className="field-hint">Carregando movimentos…</p>
          ) : movements.length === 0 ? (
            <p className="field-hint">Nenhuma venda registrada neste caixa.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Descrição</th>
                    <th>Forma</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td>{fmt(m.createdAt)}</td>
                      <td>{m.description}</td>
                      <td>{PAYMENT_METHOD_LABEL[m.paymentMethod]}</td>
                      <td>{formatReais(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {dialog === "open" && companyId && (
        <OpenCashDialog
          source={source}
          companyId={companyId}
          onOpened={() => {
            setDialog(null);
            setSelectedId(null);
            void reload();
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close" && myOpen && (
        <CloseCashDialog
          source={source}
          cash={myOpen}
          operatorName={profile?.full_name ?? null}
          movements={ownMovements}
          onClosed={() => {
            setDialog(null);
            void reload();
            notifyCashChanged();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "close-other" && selected && movements && (
        <CloseCashDialog
          source={source}
          cash={selected}
          operatorName={selected.openedByName}
          movements={movements}
          requireNotes
          title="Fechar caixa do operador"
          notesHint="Ex.: Operador encerrou o expediente sem fechar o caixa."
          onClosed={() => {
            setDialog(null);
            void reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
