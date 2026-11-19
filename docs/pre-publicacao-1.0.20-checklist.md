# Checklist de pré-publicação — v1.0.20 (nada executado no remoto)

Complementa `pagamentos-parciais-operacao-e9-8.md`. Auditoria remota feita em 2026-11-19 (somente leitura).

## 1. Identificação do Supabase de produção
- Projeto vinculado (`supabase/.temp/linked-project.json`): ref **`endbovcvhfvaynqjronl`**, nome `orca-facil`, organização `vviktyfqmixfclcruecq`. Mesmo ref fixo no `deploy-supabase.yml` e no único projeto autorizado. PostgreSQL 17.6, 3 empresas, 0 contas abertas no momento da consulta.
- Antes de qualquer comando remoto: `cat supabase/.temp/project-ref` = `endbovcvhfvaynqjronl`. CLI: `node_modules/@supabase/cli-windows-x64/bin/supabase.exe` (2.117.0). Nunca `config push`/`config pull`, nunca `--prune`.

## 2. Migrations realmente pendentes (comparação local × remoto)
Remoto contém todas até `20261212010000`; **nenhuma migration só-remota**. Pendentes, nesta ordem (11):
`20261213010000_partial_payments_foundation`, `20261213020000_session_financial_state`, `20261213030000_register_service_payment`, `20261213040000_replace_session_split`, `20261213050000_excess_allocation`, `20261213060000_refund_open_session_payment`, `20261213070000_order_cancellation_protection`, `20261214010000_order_engine_session_lock`, `20261214020000_close_settled_service_session`, `20261215010000_partial_payments_read_model`, `20261215020000_partial_payments_write_gate`.
Consulta de leitura confirmou: módulo `partial_payments` **inexistente**; 0 overrides dele (há 4 overrides de outros módulos); nenhuma das 6 tabelas, 8 funções ou colunas (`service_refunds.restores_balance/client_request_id`, `service_payments.client_request_id`) existe; `cash_session_totals` com 14 colunas (passará a 15). Módulos atuais: delivery, estoque, financeiro, ia, impressao, producao, whatsapp.

## 3. Backup necessário
- Ponto de restauração/backup do projeto (painel Supabase) imediatamente antes; anotar horário. Opcional: dump de `public` (somente esquema) para comparar `pg_proc`/políticas depois (`acl-snapshot.mjs` em `.claude/remote`).
- Janela: horário sem movimento (hoje 0 contas abertas); migrations são rápidas e aditivas, mas o gatilho de fechamento e a RPC do motor de pedidos são substituídos (travas breves).

## 4. Ordem segura de aplicação
1. `migration list --linked` (confirmar as mesmas 11 pendentes).
2. `db push --linked --dry-run` (conferir lista e ordem).
3. **Autorização explícita do dono** → `db push --linked --yes` (aplica as 11 em ordem; não usar o workflow).
4. Verificações da seção 5.
5. Só depois: bump de versão, tag e release (seção 7). O banco novo tolera o front 1.0.19; o front 1.0.20 tolera o módulo desligado.

## 5. Verificações posteriores (somente leitura, sem habilitar nada)
- `migration list --linked`: 0 pendentes.
- `select count(*) from modules where code='partial_payments'` = 1 e `is_active=false`, preço 0; `company_module_overrides` com `module_code='partial_payments'` = 0.
- RPCs novas: `authenticated` executa, `anon` não; somente `partial_payments_refund_restores` entre as `partial_payments_*` executável por `authenticated`; `db advisors --linked --type security` sem novidade crítica.
- `report_period` de uma empresa real devolve JSON **sem** as chaves novas (módulo desligado) e igual ao anterior; `cash_session_totals` com 15 colunas, as 14 anteriores na mesma ordem.
- Fluxo tradicional (empresa real, módulo desligado): abrir conta de teste e fechar com `close_service_session`; pedido novo; cancelamento de item; delivery/retirada; WhatsApp (conversa de teste). Sem dados fictícios persistentes: usar a conta da própria empresa de teste e removê-la pelo fluxo normal, ou só leituras.
- Confirmar que nenhum cliente recebeu o módulo.

## 6. Rollback
1. Problema com o recurso: nada a desfazer (módulo desligado para todos); se algum override foi criado no piloto → `update ... set expires_at = now()`.
2. Problema nas migrations (improvável: aditivas): reverter **na ordem inversa** com `supabase/rollbacks/*/rollback.sql` (write-gate → read-model → close-settled → order-engine-session-lock → order-cancellation → refund-open → excess → split → register → state → foundation). Só enquanto não houver dados do recurso novo (os scripts recusam e informam).
3. Pior caso: restaurar o backup do passo 3 (perde o que foi gravado depois — usar só com a operação parada).
4. Front: voltar à 1.0.19 não exige mexer no banco; Desktop: publicar versão corretiva (o updater segue o manifesto `desktop-latest`).

## 7. Versionamento Web/PWA e Desktop → 1.0.20 (ainda NÃO alterado)
Editar para `1.0.20`: `apps/web/package.json`, `apps/desktop/package.json`, `apps/desktop/package-lock.json` (2 ocorrências), `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock` (pacote do app), e mover `docs/release-notes-1.0.20.md` de "rascunho" para final. O PWA lê a versão do `package.json` no build (`version.json`). `release-desktop.yml` dispara só em tag `v1.0.20` e exige: tag = `tauri.conf.json` = `apps/desktop/package.json`; Secrets Tauri (existem) e Variables `VITE_*`; chave pública do updater real. Print-agent (1.0.5) não muda.

## 8. Plano de teste local, instalação e validação do Desktop (antes de publicar)
1. Com o bump aplicado localmente (sem tag): `npm run build` (web) e `npx tsc --noEmit` verdes; testes alvo (E9.x front, Balcão 82).
2. `cd apps/desktop && npm run build:installer` (build local NSIS **não assinado**, sem tag/release) → instalar em máquina de teste ou VM; abrir, login, Caixa, Balcão (rota própria), Atendimento; conferir versão exibida = 1.0.20.
3. Com o módulo desligado: tudo igual à 1.0.19. Piloto (após banco aplicado e override): roteiro do checklist de piloto em `pagamentos-parciais-operacao-e9-8.md`.
4. Atualização automática: instalar a 1.0.19 publicada, depois publicar 1.0.20 e verificar o updater (só na fase de release, com sua autorização).
5. PWA: após deploy do front, recarregar nos aparelhos do Caixa (service worker); conferir `/version.json` = 1.0.20.
6. Tag e release só com autorização expressa; ordem: banco → front/PWA → tag Desktop.
