# Agente de Impressão (Windows) — Gestão Atendimento Pro

App Windows independente (Tauri 2 + TypeScript + Rust). **Etapa 3: documento (PrintDocument) → ESC/POS (CP850/CP860/CP1252, 58/80 mm, corte none/partial/full) → spooler RAW.
Jobs do servidor continuam SEMPRE em SIMULAÇÃO** (o Rust recusa `purpose=job`); só o botão "Imprimir teste físico" do
Diagnóstico (clique + confirmação) imprime.

## Rodar / gerar
```
cd apps/print-agent
npm install            # o agente NÃO é workspace do monorepo (lock próprio)
npm test                 # testes do núcleo (node:test)
npm run audit:secrets    # garante: nenhum service_role no agente, no PWA ou em .env versionado
./node_modules/.bin/tauri dev            # desenvolvimento
./node_modules/.bin/tauri build --no-bundle   # src-tauri/target/release/print-agent.exe (sem instalador)
cd src-tauri && cargo test list_real_printers -- --nocapture   # lista as impressoras reais (não imprime)
```
Requer `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (chave **pública**) no `.env` da raiz.

## Segurança
- Sem service_role. O agente só usa URL + chave anon e a credencial própria `(agent_id, token)`, validada
  pelas RPCs (`pair_print_agent`, `print_agent_heartbeat`, `list_agent_print_devices`, `bind_print_device`,
  `claim_print_jobs`, `complete_print_job`, `fail_print_job`). O banco guarda só o hash do token.
- `machine_id` = UUID gerado na 1ª execução (sem serial/MAC/hardware). `%APPDATA%/br.com.gestaoatendimentopro.printagent/state.json`
  guarda só machine_id, agent_id e nomes. **O token fica no Windows Credential Manager** (crate `keyring`); se o cofre
  falhar, o pareamento NÃO continua (sem fallback em texto puro). Revogar/desconectar remove o token do cofre.
- O token nunca é escrito no log.

## Fluxo
claim (a cada 2 s, até 5 jobs, SKIP LOCKED no servidor) → render (texto) → print (**simulado**) → complete.
Falha → `fail_print_job`. Claim esquecido > 5 min vira erro no servidor (não reimprime sozinho).
Heartbeat a cada 30 s. Sem internet: mostra "Sem conexão com o servidor", recua o polling e reconecta sozinho.

## Próximas etapas
ESC/POS real (trocar só o passo `print` em `src/core/processor.ts`), iniciar com o Windows, bandeja,
instalador/auto-update.
