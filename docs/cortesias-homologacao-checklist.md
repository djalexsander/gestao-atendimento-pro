# Cortesias — checklist de homologação em PostgreSQL real (migrations 20261115 a 20261122)

**Status:** preparado na Etapa 5B e estendido na 5C-1 (F1, migration 20261121) e na 5C-3 (alertas F1 e acesso temporário no tenant, migration 20261122). **Nada deste documento foi executado contra PostgreSQL real nem contra produção.**
Tudo que a auditoria 5A provou foi em PGlite (um processo, sem concorrência de verdade, sem `pg_cron`, sem Realtime, relógio simulado).
Este checklist cobre o que o PGlite **não consegue** provar.

## 0. Onde homologar (decisão do usuário)

| Opção | O que é | Prós | Contras |
|---|---|---|---|
| **A. Stack local** (`supabase start`) | PostgreSQL 17 real em Docker na máquina | Zero risco para dados reais; concorrência e deadlock reais; reinicia limpo | Docker Desktop está instalado, mas o serviço **não estava em execução** nesta máquina; sem Auth/Edge reais completos |
| **B. Projeto Supabase novo e isolado** | Projeto descartável, só para homologar | Idêntico ao ambiente real (extensões, `pg_cron`, rede) | Custo/tempo; exige criar projeto e vincular com `supabase link` |

**Nunca** use `endbovcvhfvaynqjronl` (produção) nem outro projeto com dados reais. Antes de qualquer comando contra um alvo remoto,
confirme o `project-ref` (`supabase/.temp/project-ref` e `supabase projects list`) e que ele é o de homologação.

Critérios do ambiente: PostgreSQL 17.x; sem secrets do Asaas (ou só Sandbox); Edge Functions de cobrança **não** implantadas/ativas;
sem webhooks apontando para ele; `pg_cron` desligado ou sem o job de faturamento (a migration `…100000_billing_cron` agenda o ciclo — não aplique-a lá, ou desagende);
relógio: o banco usa `business_now() = now()`. Em homologação **isolada** pode-se instalar o relógio de teste (`.claude/db-tests`
mostra o `create or replace function public.business_now()` com `test.now`); **jamais** em produção.

## 1. Ordem de execução

1. Aplicar no alvo de homologação todas as migrations **anteriores** a 1115 (o pré-flight as exige: `prerequisites_missing` vira `drift`). Depois,
   `supabase db push --dry-run` no alvo (lista o que seria aplicado — é só leitura) deve listar **somente** 1115–1122 como pendentes.
   *(Para produção isso significa: se houver migrations anteriores ainda não publicadas, elas têm de sair antes — consultar a seção 4.)*
2. Pré-flight: `courtesy-preflight.sql` → esperado `verdict = ready`, `safe_to_apply = true`, `next_migration = 20261115010000`.
3. Snapshot de referência: `node .claude/remote/acl-snapshot.mjs pre-cortesias` (funções, ACL, tabelas, políticas, triggers).
4. Aplicar **uma migration por vez** (8: 1115 a 1122) (workdir temporário só com a próxima — ver `reference_remote-validation-tooling`), rodando o pré-flight depois de cada uma:
   `partial` com `observed_stage` = 1…7 e, ao fim, `applied` (8). Qualquer `drift` interrompe.
5. Snapshot final e `acl-snapshot.mjs --diff pre-cortesias pos-cortesias`: só objetos de cortesia novos; nenhuma ACL de função antiga ampliada.
6. Rodar os blocos H-* abaixo. Guardar a saída de cada um em `docs/revisao-final/` ou pasta de evidências combinada.
7. Ensaio de rollback (H-ROLL) e reaplicação, **depois** de tudo, no final.

## 2. Itens

Legenda: **Como** = o que executar; **Esperado** = condição de aprovação. Todos são bloqueantes para promover a produção, salvo indicação.

### H-PRE — pré-flight de deriva
| ID | Como | Esperado |
|---|---|---|
| H-PRE-1 | Rodar o pré-flight em cada etapa 0…6 | veredito conforme a etapa (`ready`/`partial`/`applied`), `mismatches = []`, histórico consistente |
| H-PRE-2 | Induzir deriva: `create or replace` de `company_entitlement` com um comentário a mais, rodar o pré-flight | `drift` apontando a função; `safe_to_apply = false`. Restaurar e confirmar `ready` |
| H-PRE-3 | Comparar o hash das 13 funções pré-existentes no alvo com `manifest.json` (etapa 0) **antes** de começar | idênticos. Se divergir por diferença de versão do PostgreSQL (e não de conteúdo), registrar e decidir antes de seguir |
| H-PRE-4 | `node scripts/courtesies/gen-preflight.mjs --check` | arquivos gerados atualizados |

### H-CONC — concorrência real e deadlocks
Usar o padrão de `race-lib.mjs` (sessões independentes, barreira no relógio do servidor, `N=60`, `PERIOD≈1,2`) — ver
`reference_remote-validation-tooling`. Medir `select deadlocks from pg_stat_database where datname = current_database()` **antes e depois**.
Habilitar `log_lock_waits = on` e `deadlock_timeout = 1s` no ambiente de homologação.

| ID | Cenário (sessões em paralelo) | Esperado |
|---|---|---|
| H-CONC-1 | `master_grant_courtesy` × `master_grant_courtesy` na mesma empresa (mesmo e diferente `request_id`) | exatamente 1 cortesia aberta (índice único); a outra falha limpa; nenhum deadlock |
| H-CONC-2 | `master_grant_courtesy` × `master_start_trial` / `master_subscribe_company` na mesma empresa | ordem de locks empresa → cortesia respeitada; zero deadlock |
| H-CONC-3 | `master_extend_courtesy` × `master_end_courtesy` na mesma cortesia | um vence de forma consistente; evento coerente com o estado final |
| H-CONC-4 | `master_convert_courtesy` × `master_subscribe_company` (mesma empresa/plano) | no máximo 1 assinatura; no máximo 1 ponte; cortesia `converted` uma vez |
| H-CONC-5 | `master_convert_courtesy` × `run_billing_cycle()` | sem deadlock (ciclo não trava empresa; usa assinatura → cortesias SHARE) |
| H-CONC-6 | `generate_subscription_invoice` (ciclo) × `master_end_courtesy` / `master_extend_courtesy` | fatura gerada com a isenção correta para o estado **commitado**; sem fatura duplicada |
| H-CONC-7 | `run_billing_cycle()` × `run_billing_cycle()` | sem duplicidade de faturas/eventos (idempotência por chave única) |
| H-CONC-8 | Uma transação longa (estilo `race-sweep` F2/G2: ciclo) × operações Master em dezenas de empresas | zero deadlock; nenhum `statement_timeout` |
| H-CONC-9 | `deadlocks` do `pg_stat_database` no fim | **0** novos |

### H-SKIP — `FOR UPDATE SKIP LOCKED` (`courtesy_reconcile_expired`)
| ID | Como | Esperado |
|---|---|---|
| H-SKIP-1 | Sessão A: `begin; select … from company_courtesies where id = X for update;` (mantém). Sessão B: `run_billing_cycle()` | B **não espera** (retorna em < 1 s), pula X; resultado do ciclo reporta o que processou |
| H-SKIP-2 | A faz `commit`. Novo `run_billing_cycle()` | X é processada agora (`expired_pending_decision`, 1 evento `expired`) |
| H-SKIP-3 | Duas sessões chamam `master_reconcile_courtesies()` ao mesmo tempo com N cortesias vencidas | cada cortesia recebe **um** evento `expired`; a soma de processadas = N |
| H-SKIP-4 | Cortesia presa em lock por tempo longo | ciclo conclui os demais; X reaparece no próximo ciclo (não se perde) |

### H-ACL — permissões
| ID | Como | Esperado |
|---|---|---|
| H-ACL-1 | `acl-snapshot.mjs --diff` pré × pós | só funções de cortesia novas; nenhuma função antiga ganhou EXECUTE para `anon`/`authenticated` |
| H-ACL-2 | Para cada RPC `master_*courtesy*`, `master_list_courtesy_*`, `master_get_courtesy_*`: chamar como `anon`, usuário comum, dono de empresa, funcionário, master | só master executa; os demais recebem erro de permissão (`42501`/`not authorized`) |
| H-ACL-3 | Helpers internos (`courtesy_*`, `company_*_pre_courtesy`) como `authenticated` e `service_role` | **sem** EXECUTE para `authenticated`. Em PGlite (pior caso de ACL), das 36 funções novas, `anon` executa 0, `authenticated` executa exatamente as 14 RPCs `master_*` (todas protegidas por `assert_master_admin()`), e `service_role` executa 25 (as 14 + 11 helpers internos — achado cosmético da 5A). Reconfirmar os mesmos números em PG real |
| H-ACL-4 | `supabase db advisors --linked --type security` (somente leitura) antes × depois | nenhum alerta novo ligado a cortesias |
| H-ACL-5 | `SECURITY DEFINER` sem `search_path`? | todas as novas com `set search_path = public` |

### H-RLS — políticas
| ID | Como | Esperado |
|---|---|---|
| H-RLS-1 | `company_courtesies`, `company_courtesy_events`, `courtesy_billing_records`, `courtesy_access_bridges`: `select/insert/update/delete` direto como `anon`, dono, admin, caixa, atendente de **outra** empresa | tudo negado (RLS ligado + deny) |
| H-RLS-2 | Mesma coisa como dono da **própria** empresa | negado também (cortesia é só do Master, via RPC) |
| H-RLS-3 | Triggers de append-only: `update/delete` em eventos, registros de faturamento e pontes como superusuário | recusado pelo trigger |
| H-RLS-4 | `company_write_blocked` em tabelas operacionais reais (pedido, caixa, etc.) para empresa em `courtesy`, `pending_payment` com/sem ponte | escrita liberada/bloqueada conforme a regra; teste de ponta a ponta com um usuário real de teste |

### H-IDEM — idempotência (`request_id`)
| ID | Como | Esperado |
|---|---|---|
| H-IDEM-1 | Repetir cada RPC (`grant/extend/end/request_conversion/convert`) com o mesmo `request_id` e parâmetros iguais | mesmo resultado; **sem** novo evento/registro |
| H-IDEM-2 | Duas sessões simultâneas com o mesmo `request_id` | um evento só; a outra devolve o mesmo resultado |
| H-IDEM-3 | Mesmo `request_id` com parâmetros **diferentes** | registrar o comportamento atual (achado importante 8 da 5A: o replay devolve o resultado original sem sinalizar a divergência) |
| H-IDEM-4 | Repetir `run_billing_cycle()` 3× no mesmo instante | sem faturas, itens nem eventos duplicados |

### H-BILL — faturamento (sem tocar cobrança real)
| ID | Como | Esperado |
|---|---|---|
| H-BILL-1 | Cortesia de módulo cobrindo a competência | fatura sem o módulo, ou item negativo `adjustment`; nunca valor negativo no total |
| H-BILL-2 | Cortesia de plano cobrindo tudo da competência | **nenhuma fatura criada** (registro em `courtesy_billing_records`, `waived`) |
| H-BILL-3 | Isenção parcial (cortesia termina no meio do ciclo) | item `adjustment` proporcional; total = esperado (comparar com cálculo manual) |
| H-BILL-4 | Cursor do ciclo com competência isenta | próximo ciclo não regera nem pula competência; `billing_next_due_date` coerente |
| H-BILL-5 | Assinatura paga/trial/override/`explicit_only` sem cortesia | faturas e acesso **idênticos** a uma empresa de controle (compare dois bancos: antes × depois das migrations) |
| H-BILL-6 | `billing_jobs` e filas do Asaas | nenhum job novo por competência isenta; nenhuma chamada ao Asaas (Edge Functions ausentes/sem secret) |
| H-BILL-7 | Conversão: `master_convert_courtesy` → `master_subscribe_company` (plano da cortesia) | 1 assinatura `pending_payment`, 1 fatura inicial integral, 1 ponte (24–168 h), cortesia `converted`; nenhum Pix criado pelo banco |
| H-BILL-8 | Pagar a fatura inicial pelo fluxo normal (`master_mark_invoice_paid`) | `active`; ponte deixa de valer; acesso = o da assinatura |
| H-BILL-9 | Ponte vencida sem pagamento | volta a bloquear sozinha (derivada, sem job) |

### H-ISO — isolamento entre empresas
| ID | Como | Esperado |
|---|---|---|
| H-ISO-1 | Empresas A (cortesia) e B (paga) no mesmo plano | B não muda estado, entitlement, faturas nem ciclo por causa da cortesia de A |
| H-ISO-2 | Usuário de A tenta ler/alterar dados de cortesia de B (RPC e tabela) | negado |
| H-ISO-3 | Listas do Master (`master_list_*`) | filtram por empresa; sem vazamento de outra empresa |
| H-ISO-4 | Excluir empresa com cortesia/ponte | cascade permitido; nenhum órfão |

### H-TZ — datas e fuso
| ID | Como | Esperado |
|---|---|---|
| H-TZ-1 | Cortesias que vencem às 23:59 e 00:01 de `America/Sao_Paulo` | vencem no dia correto (UTC−3 fixo); contadores "vence em N dias" corretos |
| H-TZ-2 | Fim de mês / ano / bissexto (28–31 de cada mês) com `billing_starts_competence` padrão | competência correta (max(cursor, competência atual + 1 mês)) |

### H-PERF — desempenho
| ID | Como | Esperado |
|---|---|---|
| H-PERF-1 | `explain analyze` de `company_entitlement`, `company_access_state`, `company_write_blocked` com 1 000+ empresas e 10% com cortesia | latência por chamada na mesma ordem de grandeza de antes das migrations; índices usados (`company_courtesies_open_ends_idx`, `…_company_idx`) |
| H-PERF-2 | `run_billing_cycle()` com milhares de assinaturas | tempo similar ao anterior; não excede `statement_timeout` |

### H-ROLL — ensaio de rollback (no ambiente de homologação)
| ID | Como | Esperado |
|---|---|---|
| H-ROLL-1 | Seguir `supabase/rollbacks/courtesies/LEIAME.md` passo a passo, com pré-flight entre eles | cada passo volta à etapa anterior; no fim `ready` |
| H-ROLL-2 | `acl-snapshot.mjs --diff` do estado pré-cortesias × após rollback total | **sem diferenças** (exceto, se houver eventos novos, a restrição `NOT VALID` durante o passo 3) |
| H-ROLL-3 | Verificar se a CLI `db query -f` executa o arquivo inteiro em transação única (provocar erro no meio de um arquivo de teste) | registrar; se não for atômico, **sempre** envolver em `begin; … commit;` |
| H-ROLL-4 | Reaplicar 1115–1122 depois do rollback | aplica sem erro; pré-flight `applied` |

### H-F1 — preservação em `pending_payment` (migration 20261121)
| ID | Como | Esperado |
|---|---|---|
| H-F1-1 | Cortesia do plano A + `master_subscribe_company` do plano B (com extra) | estado `pending_payment`, `write_blocked=false`, modo `courtesy_pending_payment`, módulos = plano A + cortesias de módulo + overrides válidos; **nenhum** módulo de B nem extra |
| H-F1-2 | Tentar `pending_payment → active` sem a inicial paga (RPC e SQL direto) | recusado; fatura e assinatura intactas |
| H-F1-3 | Controles: `pending_payment` comum com override; só cortesia de módulo; trial + B sem cortesia | bloqueados, sem módulos nem overrides (regra geral intacta) |
| H-F1-4 | Encerrar a cortesia A; pagar a inicial; cancelar a pendente; suspender; restringir | cada um volta à regra normal correspondente na hora (sem job) |
| H-F1-5 | Cortesia vencida (`expired_pending_decision`) com B pendente por muito tempo | janela mantida; ciclo (`run_billing_cycle`) não a altera |
| H-F1-6 | Ponte 2C ativa + outra cortesia de plano aberta | modo `payment_bridge` (prioridade da ponte) |
| H-F1-7 | Concorrência: pagamento da inicial × leitura de `company_entitlement`/`company_write_blocked` em loop; `master_end_courtesy` × leitura | leituras sempre coerentes com o estado commitado; zero deadlock (funções são `STABLE`, sem escrita) |
| H-F1-8 | Escrita real (RLS) de um usuário da empresa na janela e fora dela | passa na janela; PT402 fora |
| H-F1-9 | ACL dos helpers `courtesy_preserved_*` | sem EXECUTE para `anon`, `authenticated` e `service_role` |

### H-ALR — alertas da F1 e acesso temporário do tenant (migration 20261122)
| ID | Como | Esperado |
|---|---|---|
| H-ALR-1 | `master_list_courtesy_attention('preserved_pending_payment', 7, 100, 0)` e `master_get_courtesy_counters(7)` com empresas em F1, ponte 2C, pendente comum, só cortesia de módulo e mesmo plano | só as F1 efetivamente ativas (uma linha por empresa); `preserved_pending_payment` e `preserved_pending_oldest_days` coerentes; ponte e controles fora |
| H-ALR-2 | Paginar `all` e `preserved_pending_payment` (limit 3, 100; offset além do fim) com 1 000+ empresas | sem repetição nem salto, total constante, ordem estável (mais antiga primeiro), tempo de resposta aceitável (a lista chama `courtesy_preserved_info` por assinatura pendente — medir `explain analyze`) |
| H-ALR-3 | Concorrência: pagar a inicial / `master_end_courtesy` / cancelar a pendente em paralelo com leituras da lista e do contador | leituras sempre coerentes com o estado commitado (funções `STABLE`, sem escrita); zero deadlock |
| H-ALR-4 | Datas: `days_pending` em 23:59/00:00 de `America/Sao_Paulo`, virada de mês e de ano; assinatura criada no futuro (relógio de teste) | arredonda para baixo; nunca negativo |
| H-ALR-5 | ACL/RLS: `anon`, dono de empresa e usuário comum chamando a lista/contador | recusados (só Master); ACL das 3 funções igual à anterior (anon sem EXECUTE) |
| H-ALR-6 | `tenant_get_access_state` como dono e como funcionário da empresa em F1, em ponte 2C ativa, em pendente comum, ativa | `courtesy_preserved`/`bridge_until` explícitos e corretos; `bridge_until` = `until_at` real; só os 8 campos esperados |
| H-ALR-7 | `tenant_get_access_state` de OUTRA empresa e anônimo | PT403 / recusado; nada vaza |
| H-ALR-8 | Ponte vencida sem pagamento; F1 encerrada manualmente; F1 após o pagamento | `bridge_until` nulo e escrita bloqueada; `courtesy_preserved` falso |
| H-ALR-9 | App apontando para o ambiente de homologação: banner do tenant e Meus Planos | ponte: data/hora real + aviso de bloqueio; F1: mensagem de cortesia preservada sem prazo; ambiente sem a migration: texto genérico |
| H-ALR-10 | Painel Master: KPI, filtro e linhas "Cortesia preservada aguardando pagamento"; selo na lista de empresas | contagem igual ao contador do banco; sem prazo de ponte inventado |

### H-APP — aplicação (opcional nesta fase)
Rodar o frontend apontando para o ambiente de homologação (não o de produção): fluxos do painel Master de cortesias (conceder, prorrogar, encerrar, solicitar/autorizar conversão,
contratar plano pago pelo fluxo existente) e o que o tenant vê em `courtesy`/`pending_payment`. Login por usuário de teste do próprio ambiente.

## 3. Registro de evidências e critério de GO

Para cada item: data/hora, alvo (`project-ref`), versão do PostgreSQL, comando, saída resumida, aprovado/reprovado.
**GO para produção** somente se: todos os H-PRE, H-CONC, H-SKIP, H-ACL, H-RLS, H-IDEM-1/2/4, H-BILL, H-ISO e H-ROLL aprovados; `deadlocks` novos = 0;
nenhuma divergência (`drift`) não explicada no pré-flight; pendências H-IDEM-3 e H-APP decididas por escrito.

## 4. Como consultar as migrations realmente aplicadas (somente leitura)

CLI confirmada (versão 2.117.0, apenas pelo `--help`, sem tocar o remoto):

```bash
node node_modules/@supabase/cli-windows-x64/bin/supabase.exe migration list --linked
```

Lista **local × remoto** lado a lado (coluna *Remote* vazia = pendente no remoto; *Local* vazia = aplicada no remoto sem arquivo local — alerta de deriva).
Também aceita `--db-url` (percent-encoded) e `--local`.

Pela consulta SQL (somente leitura), útil para guardar evidência:

```bash
node node_modules/@supabase/cli-windows-x64/bin/supabase.exe db query --linked -o json "select version, name from supabase_migrations.schema_migrations order by version"
```

Atenção: `db query` devolve só o resultado do **último** comando e consome barras invertidas (nunca as use em SQL remoto).
O pré-flight (`courtesy-preflight.sql`) já lê `supabase_migrations.schema_migrations` e confronta com as definições reais.

Para ver o que um `push` faria, sem aplicar: `supabase db push --linked --dry-run`.

**Não rodar** neste processo: `db push` sem `--dry-run`, `db reset`, `migration repair`, `migration up`, `config push`, `functions deploy`, ou qualquer `db query` com
comando de escrita (`insert/update/delete/create/alter/drop/grant`) fora do ambiente de homologação já aprovado.

## 5. O que o PGlite já provou (não repetir; só reconfirmar o que muda em PG real)
Regras de elegibilidade e estados; patches exatos nas funções; reaplicação e rollback do schema (equivalência exata de funções/ACL/colunas/políticas/triggers/índices);
compatibilidade com banco populado (resultado idêntico sem cortesias); contrato frontend↔banco; ponte forjada não libera; ordem de locks por análise de código.
