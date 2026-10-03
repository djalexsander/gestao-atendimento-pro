import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../app/useAuth";
import { ConfirmDialog, ManageAgentDialog, PairingCodeDialog } from "./AgentDialogs";
import { JobDetailsDialog, PrinterDialog, RemovePrinterDialog, formatDateTime } from "./PrinterDialogs";
import { PrintQueue } from "./PrintQueue";
import { supabasePrintingSource, type PrintingSource } from "./printingApi";
import { createQueueController, type QueueState } from "./printingQueueLogic";
import { startPrintLive, startUiClock } from "./printingLive";
import { createTestFeedback, type TestFeedback } from "./printingTestFeedback";
import {
  deviceStatusLabel,
  isDeviceAgentOffline,
  destinationLabels,
  describeEnqueueFailure,
  isAgentOnline,
  lastContactLabel,
  documentLabels,
  physicalPrinterLabel,
  type PrintAgent,
  type PrintDevice,
  type PrintEnqueueFailure,
  type PrintJob,
  type PrintSector,
} from "./printingLogic";

type Tab = "printers" | "agents" | "queue";
type OpenDialog =
  | { kind: "add" }
  | { kind: "edit" | "remove"; device: PrintDevice }
  | { kind: "details"; job: PrintJob }
  | { kind: "pair" }
  | { kind: "manage-agent"; agent: PrintAgent }
  | { kind: "revoke-agent"; agent: PrintAgent }
  | { kind: "unbind"; device: PrintDevice };

// Configurações → Impressão: impressoras DINÂMICAS (um card por impressora cadastrada, nenhum
// slot vazio) e fila de impressão. Só owner/admin (o Administrativo já barra os demais; aqui vai
// uma segunda checagem) e, de verdade, RLS + RPCs do banco (migration 20261001010000). Nada aqui
// imprime nem lista impressoras do Windows: o navegador não consegue; isso é do Agente (etapa
// futura). Sem polling nem Realtime: a tela se atualiza após as próprias ações e no botão Atualizar.
export function PrintingSettings({ source = supabasePrintingSource }: { source?: PrintingSource }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const canManage = role === "owner" || role === "admin";

  const [tab, setTab] = useState<Tab>("printers");
  const [devices, setDevices] = useState<PrintDevice[] | null>(null);
  const [sectors, setSectors] = useState<PrintSector[]>([]);
  // Fila: Atenção + Histórico do período, geridos pelo controlador (printingQueueLogic.ts).
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [queueStarted, setQueueStarted] = useState(false);
  const queueRef = useRef<ReturnType<typeof createQueueController> | null>(null);
  const [agents, setAgents] = useState<PrintAgent[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failures, setFailures] = useState<PrintEnqueueFailure[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  // Banner do "Testar impressão": local, mas acompanha o job de teste (ver printingTestFeedback.ts).
  const [testFeedback, setTestFeedback] = useState<TestFeedback | null>(null);
  const [testDeviceId, setTestDeviceId] = useState<string | null>(null);
  const testFeedbackRef = useRef<ReturnType<typeof createTestFeedback> | null>(null);

  const reloadConfig = useCallback(async () => {
    if (!companyId) return;
    const result = await source.loadConfig(companyId);
    if (result.error || !result.data) {
      setLoadError(result.error ?? "Não foi possível carregar a configuração de impressão.");
      return;
    }
    setLoadError(null);
    setDevices(result.data.devices);
    setSectors(result.data.sectors);
  }, [companyId, source]);

  // Avisos de falha do enfileiramento automático (a venda seguiu, mas o papel pode não ter saído).
  const reloadFailures = useCallback(async () => {
    if (!companyId) return;
    const result = await source.loadFailures(companyId);
    if (result.data) setFailures(result.data);
  }, [companyId, source]);

  const reloadAgents = useCallback(async () => {
    if (!companyId) return;
    const result = await source.loadAgents(companyId);
    if (result.data) setAgents(result.data);
    setNow(Date.now());
  }, [companyId, source]);

  // Controlador da fila (um por empresa): descarta respostas antigas ao trocar de período e some junto com a tela.
  useEffect(() => {
    if (!canManage || !companyId) return;
    const controller = createQueueController({ source, companyId, onChange: setQueue });
    queueRef.current = controller;
    return () => {
      controller.dispose();
      queueRef.current = null;
      setQueue(null);
      setQueueStarted(false);
    };
  }, [canManage, companyId, source]);

  // Abre a fila (Atenção + Hoje) na primeira vez; depois, "Atualizar" = Atenção + primeira página do período.
  const startQueue = useCallback(() => {
    const controller = queueRef.current;
    if (!controller) return;
    if (!queueStarted) {
      setQueueStarted(true);
      void controller.init();
    } else {
      void controller.refresh();
    }
  }, [queueStarted]);
  const reloadAttention = useCallback(async () => {
    await queueRef.current?.reloadAttention();
  }, []);
  const reloadHistoryHead = useCallback(async () => {
    await queueRef.current?.reloadHistoryHead();
  }, []);

  useEffect(() => {
    if (canManage) {
      void reloadConfig();
      void reloadFailures();
      void reloadAgents();
    }
  }, [canManage, reloadConfig, reloadFailures, reloadAgents]);

  useEffect(() => {
    if (canManage && tab === "queue" && !queueStarted) startQueue();
  }, [canManage, tab, queueStarted, startQueue]);

  // TEMPO REAL: Realtime (fila, impressoras, agentes, avisos) -> reload coalescido; ao voltar a ficar visível,
  // um reload. Sem polling de banco. O "Atualizar" da fila continua como fallback manual.
  const queueActiveRef = useRef(false);
  queueActiveRef.current = tab === "queue" || queueStarted;
  useEffect(() => {
    if (!canManage || !companyId) return;
    return startPrintLive({
      companyId,
      subscribe: source.subscribeToChanges,
      reload: { config: reloadConfig, agents: reloadAgents, queue: reloadAttention, history: reloadHistoryHead, failures: reloadFailures },
      isQueueActive: () => queueActiveRef.current,
    });
  }, [canManage, companyId, source, reloadConfig, reloadAgents, reloadAttention, reloadHistoryHead, reloadFailures]);

  // Online/Offline depende do TEMPO (sem heartbeat não chega evento): relógio local que só recalcula, sem consultar o servidor.
  useEffect(() => {
    if (!canManage) return;
    return startUiClock(() => setNow(Date.now()));
  }, [canManage]);

  // Troca de empresa / unmount: descarta job acompanhado, mensagem e timers.
  useEffect(() => {
    const controller = createTestFeedback(setTestFeedback, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    });
    testFeedbackRef.current = controller;
    return () => {
      controller.dispose();
      testFeedbackRef.current = null;
      setTestFeedback(null);
      setTestDeviceId(null);
    };
  }, [companyId]);

  // Reavalia o banner sempre que a fila recarrega (Realtime, Atualizar, visibilidade) ou o Agente muda de Online/Offline.
  const testDevice = testDeviceId ? (devices ?? []).find((d) => d.id === testDeviceId) : undefined;
  const testAgentOffline = testDevice ? isDeviceAgentOffline(testDevice, agents, now) : false;
  useEffect(() => {
    const feedback = testFeedbackRef.current;
    if (!feedback || !queue || queue.attention === null) return;
    const known = [...queue.attention, ...(queue.history ?? [])];
    feedback.evaluate(known, testAgentOffline);
    // O job do teste pode estar fora do período exibido (ex.: olhando "Ontem"): confere o status dele direto.
    const id = feedback.trackedJobId();
    if (id && !known.some((j) => j.id === id)) {
      void source.loadJobStatus(id).then((result) => {
        if (result.data) feedback.evaluate([result.data], testAgentOffline);
      });
    }
  }, [queue, testAgentOffline, source]);

  if (!canManage) {
    return <p className="form-notice">Somente donos(as) e administradores(as) podem configurar a impressão.</p>;
  }

  // Roda a operação do diálogo; se der certo fecha, avisa e recarrega. Erro volta para o diálogo.
  async function submit(request: () => Promise<{ error: string | null }>, successNotice: string): Promise<string | null> {
    const result = await request();
    if (result.error) return result.error;
    setDialog(null);
    setActionError(null);
    setNotice(successNotice);
    void reloadConfig();
    void reloadAgents();
    if (queueStarted) startQueue();
    return null;
  }

  // Ações diretas (Testar, Reimprimir): sem diálogo, o erro aparece na própria tela.
  async function direct(id: string, request: () => Promise<{ error: string | null }>, successNotice: string) {
    setBusyId(id);
    setNotice(null);
    setActionError(null);
    const result = await request();
    setBusyId(null);
    if (result.error) {
      setActionError(result.error);
      return;
    }
    setNotice(successNotice);
    startQueue();
  }

  async function resolveFailure(id: string) {
    setBusyId(id);
    const result = await source.resolveFailure(id);
    setBusyId(null);
    if (result.error) {
      setActionError(result.error);
      return;
    }
    void reloadFailures();
  }

  // Testar impressão: o banner segue o job criado (pending → claimed → printed/error/cancelled).
  async function testPrint(device: PrintDevice) {
    setBusyId(device.id);
    setNotice(null);
    setActionError(null);
    testFeedbackRef.current?.clear();
    const result = await source.testPrint(device.id);
    setBusyId(null);
    if (result.error) {
      setActionError(result.error);
      return;
    }
    setTestDeviceId(device.id);
    testFeedbackRef.current?.track({ jobId: result.jobId ?? null, deviceId: device.id, agentOffline: isDeviceAgentOffline(device, agents, now) });
    startQueue();
  }

  function open(next: OpenDialog) {
    setNotice(null);
    testFeedbackRef.current?.clear();
    setActionError(null);
    setDialog(next);
  }


  let printersBody;
  if (devices === null) {
    printersBody = loadError ? (
      <div className="op-state">
        <button className="btn-secondary" type="button" onClick={() => void reloadConfig()}>
          Tentar de novo
        </button>
      </div>
    ) : (
      <p className="op-state">Carregando impressoras…</p>
    );
  } else if (devices.length === 0) {
    printersBody = (
      <div className="print-empty">
        <p>Nenhuma impressora configurada.</p>
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "add" })}>
          + Adicionar impressora
        </button>
      </div>
    );
  } else {
    printersBody = (
      <>
        <div className="admin-actions">
          <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "add" })}>
            + Adicionar impressora
          </button>
        </div>
        <div className="print-cards">
          {devices.map((device) => {
            const destinations = destinationLabels(device, sectors);
            return (
              <section key={device.id} className="print-card" aria-label={device.name}>
                <h3>{device.name}</h3>
                <p className="print-card-meta">{device.paper_width} mm</p>
                <dl className="print-details">
                  <dt>Automático</dt>
                  <dd>{destinations.length > 0 ? destinations.join(", ") : "Nenhum"}</dd>
                  <dt>Documentos</dt>
                  <dd>{documentLabels(device).length > 0 ? documentLabels(device).join(", ") : "Nenhum"}</dd>
                  <dt>Impressora física</dt>
                  <dd>
                    {physicalPrinterLabel(device)}
                    {device.agent_id && agents?.find((a) => a.id === device.agent_id) ? ` (${agents.find((a) => a.id === device.agent_id)!.name})` : ""}
                  </dd>
                  <dt>Status</dt>
                  <dd>{deviceStatusLabel(device, agents, now)}</dd>
                </dl>
                <div className="row-actions">
                  <button
                    className="btn-secondary btn-small"
                    type="button"
                    disabled={busyId === device.id || !device.ready}
                    aria-describedby={device.ready ? undefined : `print-hint-${device.id}`}
                    onClick={() => void testPrint(device)}
                  >
                    {busyId === device.id ? "Enviando…" : "Testar impressão"}
                  </button>
                  <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "edit", device })}>
                    Editar
                  </button>
                  {device.agent_id && (
                    <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "unbind", device })}>
                      Desvincular impressora física
                    </button>
                  )}
                  <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "remove", device })}>
                    Remover
                  </button>
                </div>
                {!device.ready && (
                  <p id={`print-hint-${device.id}`} className="field-hint">
                    Conecte o Agente de Impressão para testar.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </>
    );
  }

  let agentsBody;
  if (agents === null) {
    agentsBody = <p className="op-state">Carregando agentes…</p>;
  } else if (agents.length === 0) {
    agentsBody = (
      <div className="print-empty">
        <p>Nenhum Agente de Impressão conectado.</p>
        <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "pair" })}>
          + Conectar computador
        </button>
      </div>
    );
  } else {
    agentsBody = (
      <>
        <div className="admin-actions">
          <button className="btn-primary btn-auto" type="button" onClick={() => open({ kind: "pair" })}>
            + Conectar computador
          </button>
        </div>
        <div className="print-cards">
          {agents.map((agent) => {
            const online = isAgentOnline(agent, now);
            return (
              <section key={agent.id} className="print-card" aria-label={agent.name}>
                <h3>{agent.name}</h3>
                <dl className="print-details">
                  <dt>Status</dt>
                  <dd>
                    <span className={`status-badge ${online ? "status-active" : "status-inactive"}`}>{online ? "Online" : "Offline"}</span>
                  </dd>
                  <dt>Último contato</dt>
                  <dd>{lastContactLabel(agent, now)}</dd>
                  <dt>Computador</dt>
                  <dd>{agent.machine_name ?? "—"}</dd>
                </dl>
                <div className="row-actions">
                  <button className="btn-secondary btn-small" type="button" onClick={() => open({ kind: "manage-agent", agent })}>
                    Gerenciar
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      </>
    );
  }

  const queueBody = (
    <PrintQueue
      state={queue}
      devices={devices ?? []}
      agents={agents}
      now={now}
      busyId={busyId}
      onFilter={(filter) => void queueRef.current?.setFilter(filter)}
      onCustom={(from, to) => void queueRef.current?.setCustom(from, to)}
      onRefresh={startQueue}
      onLoadMore={() => void queueRef.current?.loadMore()}
      onDetails={(job) => open({ kind: "details", job })}
      onReprint={(job) => void direct(job.id, () => source.reprint(job.id), "Reimpressão enviada para a fila.")}
    />
  );

  return (
    <div className="sp-admin">
      <div className="op-filters" role="tablist" aria-label="Impressão">
        <button className="op-chip" type="button" role="tab" aria-selected={tab === "printers"} aria-pressed={tab === "printers"} onClick={() => setTab("printers")}>
          Impressoras
        </button>
        <button className="op-chip" type="button" role="tab" aria-selected={tab === "agents"} aria-pressed={tab === "agents"} onClick={() => setTab("agents")}>
          Agentes
        </button>
        <button className="op-chip" type="button" role="tab" aria-selected={tab === "queue"} aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>
          Fila de impressão
        </button>
      </div>

      {failures.length > 0 && (
        <div className="form-error" role="alert">
          <strong>Há falhas de impressão que precisam de atenção.</strong>
          <p className="field-hint">
            O pedido ou cancelamento foi registrado normalmente, mas pode não ter sido enviado para impressão. Confira a
            produção e marque como resolvida depois de verificar.
          </p>
          <ul className="print-failures">
            {failures.map((failure) => (
              <li key={failure.id}>
                <span>
                  {describeEnqueueFailure(failure)} · {formatDateTime(failure.created_at)}
                </span>
                <button
                  className="btn-secondary btn-small"
                  type="button"
                  disabled={busyId === failure.id}
                  onClick={() => void resolveFailure(failure.id)}
                >
                  Marcar como resolvida
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {loadError && tab === "printers" && <div className="form-error">{loadError}</div>}
      {actionError && <div className="form-error">{actionError}</div>}
      {notice && <div className="form-notice">{notice}</div>}
      {testFeedback && (
        <div className={testFeedback.kind === "error" ? "form-error" : "form-notice"} role={testFeedback.kind === "error" ? "alert" : "status"}>
          {testFeedback.text}
        </div>
      )}

      {tab === "printers" ? printersBody : tab === "agents" ? agentsBody : queueBody}

      {dialog?.kind === "add" && (
        <PrinterDialog
          devices={devices ?? []}
          sectors={sectors}
          onSubmit={(input) => submit(() => source.createDevice(companyId!, input), `${input.name} adicionada.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "edit" && (
        <PrinterDialog
          key={dialog.device.id}
          device={dialog.device}
          devices={devices ?? []}
          sectors={sectors}
          onSubmit={(input) => submit(() => source.updateDevice(dialog.device.id, input), `${input.name} atualizada.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "remove" && (
        <RemovePrinterDialog
          key={dialog.device.id}
          device={dialog.device}
          onConfirm={() => submit(() => source.archiveDevice(dialog.device.id), `${dialog.device.name} removida.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "pair" && <PairingCodeDialog generate={() => source.createPairingCode(companyId!)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "manage-agent" && (
        <ManageAgentDialog
          agent={dialog.agent}
          devices={devices ?? []}
          onUnbind={(device) => open({ kind: "unbind", device })}
          onRevoke={() => open({ kind: "revoke-agent", agent: dialog.agent })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "revoke-agent" && (
        <ConfirmDialog
          title="Revogar agente"
          text={`Revogar o agente "${dialog.agent.name}"? O computador deixa de imprimir imediatamente.`}
          hint="As impressoras vinculadas a ele ficam sem vínculo, impressões pendentes são canceladas e o histórico é preservado."
          confirmLabel="Revogar agente"
          onConfirm={() => submit(() => source.revokeAgent(dialog.agent.id), `${dialog.agent.name} revogado.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "unbind" && (
        <ConfirmDialog
          title="Desvincular impressora física"
          text={`Desvincular a impressora do Windows de "${dialog.device.name}"?`}
          hint="Impressões pendentes dela serão canceladas. O nome, os destinos e o histórico continuam."
          confirmLabel="Desvincular"
          onConfirm={() => submit(() => source.unbindDevice(dialog.device.id), `${dialog.device.name} desvinculada.`)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "details" && (
        <JobDetailsDialog job={dialog.job} loadDetails={() => source.loadJobDetails(dialog.job.id)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
