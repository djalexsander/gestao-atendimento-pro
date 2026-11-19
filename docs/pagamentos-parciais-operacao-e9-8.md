# Pagamentos parciais — operação, piloto, publicação e rollback (E9.8)

Documento de preparação. **Nada aqui foi executado no remoto.** Projeto fixo: `endbovcvhfvaynqjronl`.

## 1. Habilitar / desabilitar `partial_payments` por empresa
O módulo `partial_payments` nasce **inativo e sem preço** (migration E9.1): ninguém o recebe pela migration. A chave é por empresa, em `company_module_overrides` (só `service_role`/operador; RLS ligada; sem acesso de cliente). Colunas: `company_id`, `module_code`, `reason` (3–200 caracteres, obrigatório), `created_at`, `expires_at` (opcional, deve ser > `created_at`), `created_by`. Chave primária `(company_id, module_code)`.

**Habilitar** (SQL Editor do Supabase, como operador; uma empresa por vez):
```sql
insert into public.company_module_overrides (company_id, module_code, reason, expires_at)
values ('<COMPANY_UUID>', 'partial_payments', 'Piloto pagamentos parciais v1.0.20 - <empresa>', now() + interval '30 days')
on conflict (company_id, module_code) do update set reason = excluded.reason, expires_at = excluded.expires_at;
```
- **Motivo** obrigatório e legível (quem autorizou, qual piloto). **Expiração** recomendada (30 dias): vencido, desliga sozinho e a linha fica como histórico.
- Efeito: as RPCs de escrita (E3–E8) e a visão geral deixam de recusar ("não está habilitado") e o front mostra chips, "Pagamentos da conta" e os indicadores (owner/admin). O usuário vê depois de recarregar a página (entitlements são lidos ao carregar).

**Desabilitar** (preserva o histórico):
```sql
update public.company_module_overrides set expires_at = now()
where company_id = '<COMPANY_UUID>' and module_code = 'partial_payments' and expires_at is distinct from now();
```
(Se `now()` for igual a `created_at` por ter sido criado no mesmo instante, use `delete`.) Depois de desligar: contas JÁ com pagamento parcial/divisão ficam sem as ações novas e **o fechamento tradicional é recusado pelo banco** nessas contas — antes de desligar, quite e encerre (ou estorne) as contas parciais abertas, ou mantenha o módulo ligado até zerá-las (consulta abaixo).

**Auditoria**
- Concessão: a própria linha (`reason`, `created_at`, `expires_at`, `created_by`). Não há tabela de log de alterações do override: **registre a autorização/data no chamado do piloto** e não apague a linha ao desligar (use `expires_at`).
- Uso: `service_session_events` (eventos `payment_registered`, `payment_refunded`, `session_closed`, divisões) e `cash_movements`.
- Contas parciais abertas da empresa (antes de desligar):
```sql
select s.id, sp.code from public.service_sessions s left join public.service_points sp on sp.id = s.service_point_id
where s.company_id = '<COMPANY_UUID>' and s.status = 'open'
  and (exists (select 1 from public.service_payments p where p.service_session_id = s.id)
       or exists (select 1 from public.service_session_splits x where x.service_session_id = s.id));
```

## 2. Checklist da empresa piloto
- [ ] Empresa escolhida, com owner/admin identificados e ciente do piloto; **sem** contas abertas importantes na troca.
- [ ] Todas as migrations da seção 3 aplicadas e verificadas; módulo `partial_payments` existe, **inativo**, e nenhuma empresa tem override.
- [ ] Web/PWA e Desktop em 1.0.20 publicados; PWA recarregado nos aparelhos do Caixa.
- [ ] Caixa aberto no turno; cashier e attendant de teste ativos.
- [ ] Ligar o override (seção 1) com motivo e expiração.
- [ ] Roteiro (cada item verificado por owner/admin): conta nova → pagamento parcial em Pix → saldo e chip corretos; pagamento em dinheiro com troco; divisão por pessoas e refazer; estorno (owner/admin) e saldo reaberto; encerramento só quando quitada; attendant vê só o status; Balcão sem ações financeiras; delivery/retirada inalterados.
- [ ] Relatórios do dia: bloco "Contas abertas e correções", líquido = soma das formas, sem dupla contagem; PDF.
- [ ] Fechamento do caixa confere com o saldo esperado (estorno em dinheiro reduz o físico).
- [ ] Critério de parada: qualquer divergência de valor ⇒ desligar o override (seção 1) e abrir diagnóstico.

## 3. Plano de aplicação das migrations (NÃO executado)
Pré-requisito: o workflow `deploy-supabase.yml` **não aplica nada hoje** (secrets ausentes, ver seção 5); a aplicação é manual, pelo CLI, com autorização.
0. **Somente leitura:** `supabase migration list` (projeto linkado e conferido `endbovcvhfvaynqjronl`) para ver o que o remoto já tem. As migrations de pagamentos parciais abaixo estão só locais; confirmar também se `20261212010000` (cardápio IA) já está no remoto.
1. Backup lógico/ponto de restauração do projeto (e anotar a hora).
2. `supabase db push --dry-run` e conferir que as pendentes são exatamente as esperadas.
3. Aplicar **em ordem** (cada uma só cria objetos novos ou substitui corpos de funções/gatilhos, sem mexer em dados):
   1. `20261213010000_partial_payments_foundation` (E1, esquema aditivo)
   2. `20261213020000_session_financial_state` (E2, leituras)
   3. `20261213030000_register_service_payment` (E3)
   4. `20261213040000_replace_session_split` (E4)
   5. `20261213050000_excess_allocation` (E5, estende a RPC do E3)
   6. `20261213060000_refund_open_session_payment` (E6)
   7. `20261213070000_order_cancellation_protection` (E7, gatilho)
   8. `20261214010000_order_engine_session_lock` (E7.1, ordem de travas do motor de pedidos)
   9. `20261214020000_close_settled_service_session` (E8, troca o corpo do gatilho de fechamento)
   10. `20261215010000_partial_payments_read_model` (E9.1: módulo inativo, visão geral, `report_period`, view `cash_session_totals` com coluna nova no fim)
   11. `20261215020000_partial_payments_write_gate` (E9.1A: chave por empresa nas escritas)
4. Verificar: módulo `partial_payments` inativo e **0** overrides; RPCs novas só para `authenticated`; `report_period` com módulo desligado devolve o JSON legado; um fechamento tradicional de teste em empresa sem módulo funciona.
5. Só depois publicar Web/PWA/Desktop 1.0.20. Ordem: banco → front (o front novo tolera módulo desligado; o banco novo tolera o front antigo, porque nada muda com o módulo desligado).

Efeito sobre dados existentes: nenhuma migration faz backfill nem altera linhas; a view `cash_session_totals` ganha 1 coluna no FIM; o gatilho de fechamento passa a recusar o fechamento tradicional **só** em conta que já tenha atividade parcial/divisão (inexistente antes do piloto).

## 4. Plano de rollback
1. **Primeira resposta a qualquer problema = desligar o override** (seção 1): não reverte esquema, volta o comportamento tradicional na hora.
2. Reverter migrations só se necessário e **na ordem inversa**, com os scripts em `supabase/rollbacks/`: `partial-payments-write-gate` → `partial-payments-read-model` → `close-settled-service-session` → `order-engine-session-lock` → (E7) → `refund-open-session-payment` → (E5) → `replace-session-split` → (E3) → `session-financial-state` → `partial-payments-foundation`.
3. Os rollbacks são transacionais e **recusam** se já existir dado financeiro que só o recurso novo cria (divisão, alocações, eventos, pagamento com `client_request_id`); o rollback do read model recusa se houver concessão por empresa (informa a concessão). Nesses casos: não forçar — exportar/estornar os dados à parte e decidir.
4. Front: reverter para a 1.0.19 não exige mexer no banco (o PWA tolera). Desktop: o updater segue o manifesto; publicar nova versão corretiva.

## 5. Auditoria do workflow `deploy-supabase.yml`
- A queixa "falhou com 0 jobs" **não se reproduz**: as últimas 40 execuções (`gh run list`) terminaram com **sucesso** (~9 s). O arquivo de workflow está válido.
- Mas o job termina em "Conferir Secrets" com *"Secrets SUPABASE_ACCESS_TOKEN/SUPABASE_DB_PASSWORD não configurados: deploy ignorado (sem erro)"*. O repositório só tem os secrets do Tauri. **Ou seja, o deploy automático nunca aplica migrations** e o "sucesso" engana.
- Correção necessária (decisão do dono): (a) cadastrar `SUPABASE_ACCESS_TOKEN` e `SUPABASE_DB_PASSWORD` em Settings → Secrets, **ou** (b) manter a aplicação manual por CLI. Recomendação: manter manual para esta release (ela é sensível) e, se (a) for adotado, rodar primeiro `workflow_dispatch` em `dry-run`. Sugestão de endurecimento (não aplicada): trocar o `notice` por `::warning::` visível ou falhar quando a push contém migrations e os secrets faltam, para o "verde" não esconder migrations não aplicadas.
- Atenção: com secrets configurados, um `push` na main que toque `supabase/migrations/**` aplicaria **automaticamente** as 11 migrations acima. Por isso não configurar os secrets antes de decidir o momento.

## 6. Requisitos para versionar Web/PWA e Desktop em 1.0.20 (não alterado agora)
Arquivos do bump (mesmo padrão do commit da 1.0.19): `apps/web/package.json`, `apps/desktop/package.json`, `apps/desktop/package-lock.json` (2 ocorrências), `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` e `Cargo.lock`, mais `docs/release-notes-1.0.20.md`. `version.json` do PWA sai do `package.json` no build. O `release-desktop.yml` dispara só com tag `v1.0.20` e **exige** que tag, `tauri.conf.json` e `apps/desktop/package.json` coincidam, além dos secrets Tauri (existem) e das Variables `VITE_*`. O agente de impressão (`print-agent`, 1.0.5) não muda.
