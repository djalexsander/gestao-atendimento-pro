// Banner de feedback do "Testar impressão" (sem React, testável com relógio falso).
// O banner é estado LOCAL e transitório, mas acompanha o job de teste real (id devolvido pela RPC):
// toda vez que a fila recarrega (Realtime, Atualizar, visibilitychange) ou o Agente muda de Online/Offline,
// a tela chama evaluate() e a mensagem é recalculada a partir do status do job — nunca fica obsoleta.
import type { LiveTimers } from "./printingLive";
import type { PrintJob } from "./printingLogic";

export interface TestFeedback {
  kind: "ok" | "error";
  text: string;
}

export const TEST_FEEDBACK_MSG = {
  queued: "Teste enviado para a fila. Ele será impresso quando o Agente estiver online.",
  sent: "Teste enviado para impressão.",
  waiting: "Teste aguardando processamento pelo Agente.",
  printing: "Teste sendo impresso…",
  printed: "Teste impresso com sucesso.",
  error: "Não foi possível imprimir o teste. Consulte a fila de impressão.",
  cancelled: "Teste de impressão cancelado.",
} as const;

export const TEST_SUCCESS_CLEAR_MS = 5_000;
export const TEST_CANCELLED_CLEAR_MS = 4_000;

type TrackedJob = Pick<PrintJob, "id" | "status" | "print_device_id" | "job_type">;

// Texto do job ainda em andamento, conforme o Agente esteja online ou não agora.
export function pendingTestMessage(agentOffline: boolean): string {
  return agentOffline ? TEST_FEEDBACK_MSG.queued : TEST_FEEDBACK_MSG.sent;
}

export function createTestFeedback(onChange: (feedback: TestFeedback | null) => void, timers: LiveTimers) {
  let jobId: string | null = null;
  let deviceId: string | null = null;
  let tracking = false;
  let clearTimer: unknown = null;
  let disposed = false;

  function cancelTimer() {
    if (clearTimer !== null) timers.clearTimeout(clearTimer);
    clearTimer = null;
  }
  function show(feedback: TestFeedback | null) {
    if (!disposed) onChange(feedback);
  }
  function finish(feedback: TestFeedback, clearAfterMs: number | null) {
    tracking = false;
    show(feedback);
    if (clearAfterMs !== null && clearTimer === null) {
      clearTimer = timers.setTimeout(() => {
        clearTimer = null;
        show(null);
      }, clearAfterMs);
    }
  }

  return {
    // Novo teste substitui o anterior: zera timer e job acompanhado. jobId pode faltar (fallback por impressora).
    track(next: { jobId: string | null; deviceId: string; agentOffline: boolean }) {
      cancelTimer();
      jobId = next.jobId;
      deviceId = next.deviceId;
      tracking = true;
      show({ kind: "ok", text: pendingTestMessage(next.agentOffline) });
    },
    // Reavalia contra a fila recarregada e o estado atual do Agente.
    evaluate(jobs: TrackedJob[] | null, agentOffline: boolean) {
      if (!tracking || jobs === null) return;
      if (jobId === null) {
        // Sem id: some o banner se não houver mais teste pending/claimed dessa impressora.
        const open = jobs.some((j) => j.job_type === "test" && j.print_device_id === deviceId && (j.status === "pending" || j.status === "claimed"));
        if (!open) {
          tracking = false;
          show(null);
        }
        return;
      }
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return; // ainda não chegou na fila carregada: mantém a mensagem atual
      if (job.status === "pending") show({ kind: "ok", text: pendingTestMessage(agentOffline) });
      else if (job.status === "claimed") show({ kind: "ok", text: TEST_FEEDBACK_MSG.printing });
      else if (job.status === "printed") finish({ kind: "ok", text: TEST_FEEDBACK_MSG.printed }, TEST_SUCCESS_CLEAR_MS);
      else if (job.status === "error") finish({ kind: "error", text: TEST_FEEDBACK_MSG.error }, null);
      else finish({ kind: "ok", text: TEST_FEEDBACK_MSG.cancelled }, TEST_CANCELLED_CLEAR_MS);
    },
    // Nova ação do usuário / fechar.
    clear() {
      cancelTimer();
      tracking = false;
      jobId = null;
      show(null);
    },
    // Troca de empresa / unmount / logout: sem job, sem timer, sem notificar mais.
    dispose() {
      cancelTimer();
      tracking = false;
      jobId = null;
      disposed = true;
    },
  };
}
