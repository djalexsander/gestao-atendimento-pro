# Cortesias — homologação isolada em PostgreSQL 17 REAL (Etapa 6)

**Data:** 2026-11-06 · **Escopo:** migrations `20261115` a `20261122` · **Alvo:** container Docker local e descartável, publicado só em `127.0.0.1`.
**Nada remoto foi tocado:** sem `--linked`, sem `db push`, sem credenciais de produção, sem Asaas, sem webhook, sem commit/push/tag/deploy.
**Migrations funcionais:** não foram alteradas nesta etapa.

## 1. Ambiente

| Item | Valor |
|---|---|
| Docker Desktop | 29.9.2 (estava desligado; iniciado nesta etapa) |
| Antes de começar | 0 containers, 0 volumes, redes padrão; 1 imagem já existente (`public.ecr.aws/supabase/postgres:17.6.1.141`, 1,7 GB). Nada de outros projetos foi apagado ou sobrescrito |
| Container criado | `courtesy-homolog-pg` (rótulo `purpose=courtesy-homologation`), porta `127.0.0.1:54399 → 5432` |
| Servidor | PostgreSQL **17.6** (mesma versão do projeto remoto), papéis `anon`, `authenticated` (sem BYPASSRLS), `service_role` da imagem Supabase |
| Ajuste do cluster descartável | `log_lock_waits = on`, `deadlock_timeout = 200 ms` (superusuário `supabase_admin`, só no container) |
| Cliente | sessões `psql` persistentes via `docker exec` (cada uma é uma conexão independente); sem instalar driver |
| Trava de segurança | `assertIsolated()` recusa qualquer container sem o rótulo ou exposto fora de `127.0.0.1` |
| Shims (como no harness PGlite) | `auth.users`/`auth.uid()`, `storage`, `vault.decrypted_secrets`, `net.http_post` espelho (só registra; nada sai da máquina). `pg_cron`/`pg_net` **não** ativados |
| Relógio | `business_now()` trocado por uma tabela compartilhada `__clock` **só no banco descartável** (para simular vencimentos entre conexões) |

Recriar o ambiente (ele foi removido ao final):

```bash
docker run -d --name courtesy-homolog-pg -p 127.0.0.1:54399:5432 -e POSTGRES_PASSWORD=<senha-local> -l purpose=courtesy-homologation public.ecr.aws/supabase/postgres:17.6.1.141
docker exec courtesy-homolog-pg psql -U supabase_admin -d postgres -c "alter system set log_lock_waits = on" -c "alter system set deadlock_timeout = '200ms'" -c "select pg_reload_conf()"
```

Ferramentas novas (em `scripts/courtesies/homolog/`): `real-db.mjs` (adaptador), `preflight-real.mjs`, `concurrency.mjs` + `concurrency-lib.mjs`, `realpg-extras.mjs`, `volume.mjs`.
As suítes de banco existentes rodam no PG real com `HOMOLOG_REAL=1` (gancho aditivo em `.claude/db-tests/full-db.mjs`).

## 2. Resultados

| Bloco | Resultado |
|---|---|
| **Pré-flight em PG real** (`preflight-real.mjs`) | **21/21.** 123 migrations-base aplicadas em 2,6 s; manifesto gerado em PGlite **casa com o motor real** (etapa 0 = `ready`); ao aplicar uma a uma: `partial` 1…7 e `applied` 8; deriva injetada em 6 funções, 1 tabela e no histórico → `drift` apontando o objeto. Execução do pré-flight ≈ 50 ms, somente leitura |
| **8 suítes de cortesia** (as mesmas do PGlite, no PG real) | **534/534**: 109 + 93 + 55 + 75 + 66 + 50 + 45 + 41. Idênticas ao PGlite |
| **Concorrência** (`concurrency.mjs`, 25 corridas por cenário) | **39/39**, 0 violações, **0 deadlocks** (contador `pg_stat_database` e log) |
| **ACL, RLS, isolamento, fuso** (`realpg-extras.mjs`) | **19/19** |
| **Volume e rollback** (`volume.mjs`, 1.650 empresas por banco) | **19/19** |
| **Suíte completa do projeto em PG real** (`run-all` com `HOMOLOG_REAL=1`) | 4.888 ok; 39 suítes com falha — **todas fora de cortesias** (ver 4) |

### 2.1 Concorrência (conexões independentes, largada sincronizada no relógio do servidor)

Cenários (25 corridas cada, exceto 5a/5b com 8): conceder × conceder (mesma chave e chaves diferentes), prorrogar × encerrar, contratar × contratar na conversão, contratar × encerrar (ponte e F1), autorizar × autorizar, pedir × autorizar,
pagar × pagar, pagar × encerrar (F1), `run_billing_cycle` × `run_billing_cycle` × `master_reconcile_courtesies` (cortesias vencidas), ciclo × Master em empresas diferentes e varredura aleatória (4 workers, 212 operações).

* Latência por operação: 4–30 ms (média 11–14 ms); ciclo/reconcile concorrentes até 190 ms.
* Idempotência: `grant × grant` com a mesma chave → 25/25 `ok + ok` e **um** evento `granted`; com chaves diferentes → uma cortesia aberta; `pay × pay` → uma ativação.
* Invariantes globais depois de TODAS as corridas (12): nenhuma cortesia aberta duplicada, nenhuma assinatura vigente duplicada, **nenhuma fatura duplicada (assinatura, competência, tipo)**, uma fatura inicial por assinatura, ponte ≤ 1 por assinatura e sempre de cortesia convertida,
  eventos coerentes (um `granted`, um `ended`/`converted`), **nenhum desbloqueio indevido** (escrita liberada só em `pending_payment` com ponte ativa **ou** F1, nunca os dois), nenhuma assinatura ativa sem inicial paga.
* `SKIP LOCKED` determinístico: com a linha travada por outra transação, `master_reconcile_courtesies` responde em 8–9 ms e o ciclo em ~60 ms **sem esperar** e pulando a cortesia; liberada a trava, o próximo reconcile a processa (1 evento `expired`); o Master que quer encerrar a mesma cortesia **espera** (~920 ms) e conclui. O servidor registrou exatamente essas esperas (`still waiting for ShareLock … after 200 ms`) e **nenhum** `deadlock detected`.
* **Rollback e reaplicação sob concorrência:** leitores (estado do tenant e lista do Master) rodaram durante o rollback de 1121–1122 e a reaplicação, e durante o rollback total das 8 migrations com concessões em andamento: 0 erros de dado/permissão; schema final idêntico ao inicial; assinaturas e faturas intactas.

### 2.2 F1, ponte 2C, alertas e tenant em PG real
Cobertos pelas suítes `courtesies-preserved` (45), `courtesies-bridge` (66), `courtesies-alerts` (41) e `courtesies-conversion` (75) — todas verdes — mais as verificações do `realpg-extras`: empresa em F1 → `courtesy_preserved=true`, `bridge_until=null`, escrita liberada;
empresa de outro tenant recebe `PT403` (nada vaza); só os 8 campos esperados; o Master vê a F1 na lista e nada da empresa sem F1; a barreira real de escrita (`guard_company_writable`): cortesia → liberada, F1 → liberada, `pending_payment` comum → `PT402`. O pagamento foi simulado só no banco (`master_mark_invoice_paid`).

### 2.3 ACL / RLS / fuso (PG real)
* 39 funções de cortesia/tenant: `anon` executa **nenhuma**; `authenticated` executa exatamente as 14 RPCs `master_*` + `tenant_get_access_state` e **nenhum** helper interno (as quatro tabelas de cortesia têm RLS ligada: dono da empresa A, dono da B e `anon` leem 0 linhas, não inserem e não alteram; a cortesia continua intacta depois das tentativas).
* As funções que acessam dados são todas `SECURITY DEFINER` com `search_path` fixo; as 10 `SECURITY INVOKER` são auxiliares puras (recebem a linha por parâmetro) ou gatilhos, sem `EXECUTE` para API.
* `service_role` (que tem BYPASSRLS) executa 25 das 39 (as 14 RPCs + 11 helpers) por herança do privilégio padrão do Supabase — achado cosmético já conhecido.
* Fuso: a data final `2030-03-10` vira `2030-03-11T03:00:00Z` (fim do dia em São Paulo) com a sessão em UTC, São Paulo, Tóquio, Kiritimati e Los Angeles; `business_date()` vira exatamente em 02:59:59Z → 03:00:00Z.

### 2.4 Desempenho (1.650 empresas por banco; BASE = só migrations anteriores; FULL = 8 migrations; 250 F1, 100 pontes, 100 só-trial com cortesia, 300 pendentes comuns, 900 pagas)

| Medida | BASE | FULL | Observação |
|---|---|---|---|
| `company_access_state` (por empresa) | 6 µs | 7 µs | sem mudança |
| `company_write_blocked` (média por empresa) | 9 µs | **342 µs** | custo concentrado nas 650 empresas em `pending_payment`; empresa ativa não paga o helper |
| `company_entitlement` (média por empresa) | 25 µs | **455 µs** | idem |
| helper da F1 por assinatura pendente | — | ≈ 0,45 ms | cadeia de 4 funções SQL `SECURITY DEFINER` (não inlináveis); `Planning Time` 0,07 ms |
| Contadores do Master | — | 602 ms | linear em nº de assinaturas pendentes |
| Lista de atenção `all` / F1 (100) / F1 página profunda | — | 462 / 456 / 465 ms | idem |
| `tenant_get_access_state` (mediana de 40) | 2 ms | 4 ms | |
| `run_billing_cycle` (1 mês adiante) | 2.560 ms | 2.403 ms | sem regressão |

**Negócio idêntico:** faturas por competência/tipo/status/valor e estado/escrita das empresas SEM cortesia são **idênticos** entre BASE e FULL depois do ciclo (2.450 faturas, R$ 390 mil em ambos).

### 2.5 Rollback e reaplicação com dados (FULL: 450 cortesias, 800 eventos, 100 pontes)
* Os 8 rollbacks, em ordem inversa e cada um em **uma** transação: 6/5/5/10/11/9/4/10 ms (**61 ms no total**); pré-flight confere a etapa em cada passo e termina `ready`.
* Schema depois do rollback total **idêntico ao BASE** (funções com corpo e ACL, colunas, políticas, triggers, índices, constraints).
* Hash MD5 de todas as linhas de empresas, assinaturas, módulos, faturas e itens (exceto ajustes de cortesia): **idêntico** antes e depois; itens de ajuste e jobs de cobrança preservados.
* Reaplicação das 8 migrations sobre o banco revertido: 96 ms, schema idêntico ao de antes, pré-flight `applied`, negócio idêntico.

## 3. Achados

### Impeditivos
**Nenhum.**

### Importantes (não bloqueiam a preparação; tratar antes de crescer)
1. **Custo do helper em `pending_payment`.** `company_write_blocked`/`company_entitlement` custam ~0,35–0,45 ms por chamada em empresas pendentes (40× e 18× o valor anterior); empresa ativa não é afetada. O custo vem da cadeia aninhada de funções SQL `SECURITY DEFINER`. Os painéis do Master escalam linearmente: ~0,45 ms por assinatura pendente (600 ms com 650 pendentes; ≈ 5 s com ~10 mil).
   *Proposta (não implementada, exige migration nova):* colapsar `courtesy_preserved_info` + `courtesy_bridge_info` em uma única consulta por empresa e, nos painéis, uma consulta em conjunto (sem chamar o helper por linha).
2. **Rollback com tráfego ativo gera erro transitório de motor.** Durante o rollback/reaplicação concorrente, 2 de 436 leituras (0,46 %) falharam com `XX000: cache lookup failed for function <oid>` (chamada em voo quando o `DROP FUNCTION` dos helpers comita). Não corrompe dado nem trava. *Recomendação:* executar o rollback em janela de manutenção (o caminho de **aplicação** não tem `DROP` de função em uso e não mostrou o erro).

### Melhorias futuras
3. `pg_cron`: as duas migrations de agendamento (`…billing_cron`, `…push_cron`) **não** foram aplicadas (o papel `postgres` não tem permissão; só o registro no histórico). Validar o agendamento no projeto de homologação do Supabase.
4. As 8 migrations foram exercitadas numa **única sessão** (como o `db push`): os nomes únicos dos helpers `pg_temp` funcionam; nenhum conflito.
5. Suítes do projeto fora de cortesias (delivery, WhatsApp, pedidos, courier): ver seção 4.

## 4. Suíte completa do projeto em PG real (fora do escopo, registrada por transparência)
39 suítes falharam; **nenhuma é de cortesias** (as 8 suítes de cortesia, o `mutate-courtesy-entitlement` e a cadeia de rollback passaram). Três já falham no PGlite (`upgrade`, `order-engine-upgrade`, `mutate-customer-delete`).
Causas observadas nas demais: limites do adaptador (o papel `postgres` do Supabase não é superusuário — `session_replication_role` negado; forma/tipos das linhas devolvidas), o espelho legado do módulo IA que algumas fixtures esperam, e fixtures que dependem de comportamento do PGlite.
Elas não indicam incompatibilidade das migrations de cortesia; ficam como item separado de tooling.

## 5. Recomendação
**GO para preparação de publicação** (sem publicar nesta etapa), com condições: (a) rodar `courtesy-preflight.sql` no alvo imediatamente antes (inclui migrations anteriores pendentes); (b) aplicar uma migration por vez com o pré-flight entre elas; (c) rollback só em janela de manutenção; (d) opcionalmente homologar também em um projeto Supabase isolado para o agendamento `pg_cron` e as Edge Functions; (e) planejar a otimização do item 1 antes de crescer a base de empresas pendentes.
