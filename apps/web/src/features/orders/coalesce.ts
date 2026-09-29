// Executa `run` no máximo uma vez por vez, sem atraso: se chegar outro pedido de execução enquanto
// uma está em andamento, roda UMA vez mais assim que ela termina (o dado pode ter mudado no meio
// da busca, então não dá para simplesmente descartar). Serve para Broadcast + postgres_changes +
// foco chegando quase juntos sem gerar buscas em paralelo. Sem debounce, sem timers.
export function createCoalescedRunner(run: () => Promise<unknown>): () => void {
  let running = false;
  let pending = false;

  async function execute(): Promise<void> {
    running = true;
    try {
      await run();
    } catch {
      // quem chama trata seus próprios erros; aqui só não travamos o runner
    } finally {
      running = false;
    }
    if (pending) {
      pending = false;
      await execute();
    }
  }

  return () => {
    if (running) {
      pending = true;
      return;
    }
    void execute();
  };
}
