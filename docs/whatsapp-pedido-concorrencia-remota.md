# Pedido conversacional — plano e harness de concorrência REAL (Postgres remoto)

> **Estado: preparado e validado localmente; NÃO executado.** Pré-requisitos para executar: (1) autorização explícita do usuário;
> (2) migrations `20261021010000` … `20261021060000` aplicadas em `endbovcvhfvaynqjronl`. Nada neste plano liga `order_drafts_enabled`
> em empresa real, toca a Djalexeventos, chama a Graph/Meta, cria usuário/senha ou faz `db push`.

## 0. Arquivos (em `.claude/`, ignorados pelo git)

| arquivo | papel |
|---|---|
| `.claude/remote/order-race-lib.mjs` | só gera SQL: empresa sintética, fixtures, corredores (`racerScript`), casos A–G (`buildCases`), invariantes e limpeza |
| `.claude/remote/order-race.mjs` | runner remoto. **Dry-run por padrão**; só executa com `--execute-remote` **e** `ORDER_RACE_AUTHORIZED=endbovcvhfvaynqjronl` |
| `.claude/db-tests/order-race-smoke.mjs` | smoke local (PGlite): fixtures montam rascunhos reais, cada corredor roda, invariantes valem nas **duas ordens** sequenciais, limpeza ensaiada — **157 checagens OK**. Não prova concorrência; prova que o harness é válido |
| `.claude/remote/tmp/cleanup-order-race-<run>.sql` | SQL de limpeza gerado a cada execução, para o **usuário** revisar e rodar |

## 1. Método (igual ao da validação da Fase 4)

- **Sessões independentes, não PGlite:** cada corredor é um processo do Supabase CLI (`db query --linked`) = um backend Postgres próprio. Acesso só pelo login do próprio CLI; `q.mjs` confere a cada chamada que o projeto linkado é `endbovcvhfvaynqjronl`.
- **Barreira:** cada corredor é um `DO` que dorme (`pg_sleep`) até `T0 + (i-1)*período` no **relógio do servidor** e executa a iteração em transação própria (`COMMIT` no laço). Corredores lançados com ≥ 4,5 s de intervalo (rotação da senha do login role do CLI) e alinhados no relógio do servidor (skew de início esperado ≈ 1 ms; o runner mede e imprime a mediana e o máximo).
- **N = 20 iterações por caso** (F: 12), período 1,5 s (F: 4,5 s), para caber no `statement_timeout` de 2 min.
- **Empresa sintética** `zz-ped-<run>` (módulos `delivery`+`whatsapp` por override, modo teste, sem destinatário real, AUTO ligado só nela). Um produto de teste por iteração, para as iterações serem independentes.
- **Jobs da fixture** nascem `processing` com `locked_until = now()+2h`: o worker real não os reivindica. O harness **nunca** chama `whatsapp_ai_claim_jobs` (ela pegaria jobs de empresas reais).
- **Fixture** (por rascunho): `whatsapp_ingest_message` → conversa+job; `apply_ops` (itens + retirada); `set_payment`; resumo enviado pelo `whatsapp_ai_auto_commit_send` e marcado `sent`; `mark_summary_sent`; `COMMIT` (o `now()` do “confirmar” tem de ser posterior ao do resumo); “confirmar” ingerido → `latest_message_id` do job. O rascunho fica `awaiting_confirmation`.
- Só `delivery_orders` por retirada (sem endereço) — a revalidação de zona/taxa já é coberta com determinismo no teste local; o foco aqui é lock/estoque/preço/idempotência.
- **Pré-checagem somente leitura** antes de tudo (`confirm`, motor, tabelas e flag existem; quantas empresas já têm a flag).

## 2. Casos

Notação: `confirm(job, msg)` = `whatsapp_order_confirm`. Resultado de cada iteração é gravado no JSON do corredor (`result`, erro, tempos).

### A — Duas confirmações simultâneas do MESMO rascunho
- **Fixture:** N rascunhos; item `ZZ A-s-i` (estoque 10, qtd 2) + `ZZ Espeto livre`; impressora vinculada.
- **Sessão A / B:** ambas `confirm(job_i, msg_i)` (mesmo job e mesma mensagem: dois workers/retry com lease vencido).
- **Barreira:** `T0 + (i-1)*1,5 s` no relógio do servidor.
- **Esperado:** em cada iteração 1 `created` + 1 `already_confirmed` (mesmo `delivery_order_id`); a segunda espera o lock da conversa e depois enxerga o rascunho `confirmed`.
- **Inspeção/invariantes:** N pedidos (1 por rascunho); N baixas de estoque `sale` e saldo `10-2` por produto; exatamente 1 `print_jobs.production_order` por pedido; invariantes comuns (seção 3).

### B — Dois rascunhos disputam a ÚLTIMA unidade
- **Fixture:** N pares de conversas; produto `ZZ B-s-i` com estoque 1; cada rascunho pede 1 unidade.
- **Sessão A:** `confirm` do rascunho 1; **Sessão B:** `confirm` do rascunho 2, mesma barreira.
- **Esperado:** 1 `created` e 1 `needs_changes` (`item_unavailable`) por iteração; estoque final 0.
- **Invariantes:** N pedidos, N baixas, estoque = 0 em todos (nunca negativo); o perdedor voltou a `collecting` sem pedido.

### C — Confirmação × mudança de PREÇO
- **Fixture:** produto `ZZ C-p-i` a R$ 12; rascunho com 2 unidades (resumo R$ 24).
- **Sessão A:** `confirm`; **Sessão B:** `update products set sale_price = 15`.
- **Esperado:** `created` (A venceu: preço antigo) **ou** `price_changed` (B venceu: nenhum pedido, rascunho volta a `collecting`, novo resumo exigido); nenhum outro resultado.
- **Invariante-chave:** **nenhum item vendido com preço ≠ 12** (nunca o preço que o cliente não viu); rascunho `confirmed` ⇔ tem pedido.

### D — Confirmação × mudança de DISPONIBILIDADE
- **Fixture:** `ZZ D-p-i` com estoque 5.
- **Sessão A:** `confirm`; **Sessão B:** `update products set available_for_sale = false`.
- **Esperado:** `created` ou `needs_changes`; nunca pedido com item que já estava indisponível.
- **Invariantes:** saldo = `5N − pedidos`; baixas = pedidos; nenhum rascunho `collecting` com pedido.

### E — Ordem inversa de produtos (deadlock)
- **Fixture:** N pares; produtos `ZZ E-x-i` e `ZZ E-y-i` (ambos com estoque 10, **controlados**); rascunho 1 pede x,y; rascunho 2 pede y,x (posição invertida).
- **Sessão A / B:** `confirm` dos dois ao mesmo tempo.
- **Esperado:** os dois `created`; **nenhum `40P01`** (locks sempre por `product_id`, estoque `FOR UPDATE` e demais `FOR SHARE`, mesma ordem do motor).
- **Invariantes:** 2N pedidos; saldo x e y = `10×N − 2×N` cada.

### F — Timeout/retry depois do commit
- **Fixture:** `ZZ F-s-i`, estoque 10, 1 unidade.
- **Sessão A:** `confirm` (commita). **Sessão B:** espera 2,5 s e repete `confirm(job_i, msg_i)` (resposta perdida → retry do worker).
- **Esperado:** A `created`, B `already_confirmed` com o **mesmo** `delivery_order_id`.
- **Invariantes:** N pedidos, N baixas, saldo `9×N` (o retry não criou nada).

### G — Confirmações concorrentes + impressão + autoria
- **Fixture:** como A (impressora vinculada com “pedido completo”).
- **Sessão A / B:** `confirm` simultâneo.
- **Invariantes:** N pedidos; **1 `production_order` por pedido** (total N); todos com `created_via='whatsapp_ai'` e `created_by IS NULL` (`delivery_orders`, `service_orders`, `service_sessions.opened_by`, `product_stock_movements`, `print_jobs`); **nenhum** registro `created_via='user'` com `created_by NULL` (o NULL só existe nesse caminho).

## 3. Invariantes comuns (estado final, todos os casos)

1. nenhum rascunho com mais de um pedido; 2. todo rascunho `confirmed` tem exatamente 1 pedido e todo pedido da IA aponta para 1 rascunho `confirmed` com `delivery_order_id` de volta; 3. estoque nunca negativo; 4. autoria correta (`whatsapp_ai`, sem `created_by`, canal `whatsapp`); 5. nenhum cliente nem endereço cadastrado pela IA; 6. rascunhos encerrados sem endereço/observação geral; 7. nenhum rascunho `failed`; 8. (corredores) nenhum `40P01` nem erro inesperado.

## 4. Queries de inspeção manual (somente leitura)

```sql
-- pedidos por rascunho (esperado: nunca > 1)
select whatsapp_order_draft_id, count(*) from delivery_orders
 where company_id = (select id from companies where slug = 'zz-ped-<run>') and whatsapp_order_draft_id is not null group by 1 having count(*) > 1;
-- estoque e baixas por produto do caso
select p.name, p.stock_quantity, count(m.*) filter (where m.movement_type = 'sale') as baixas
  from products p left join product_stock_movements m on m.product_id = p.id
 where p.company_id = (select id from companies where slug = 'zz-ped-<run>') and p.name like 'ZZ A-s-%' group by 1, 2 order by 1;
-- impressões por pedido
select o.id, count(pj.*) from delivery_orders o left join print_jobs pj on pj.service_order_id = o.service_order_id and pj.job_type = 'production_order'
 where o.company_id = (select id from companies where slug = 'zz-ped-<run>') group by 1;
-- estados dos rascunhos
select status, count(*) from whatsapp_order_drafts where company_id = (select id from companies where slug = 'zz-ped-<run>') group by 1;
```

## 5. Limpeza

`tmp/cleanup-order-race-<run>.sql` (gerado em dry-run e em execução; **o harness nunca o executa**): `delete from public.companies where slug = 'zz-ped-<run>'` (cascata: conversas, mensagens, jobs, rascunhos, pedidos, atendimentos, baixas, impressões, catálogo, conexão de teste) + `delete from vault.secrets where name = 'zz-ped-<run>'`, seguido de uma consulta de confirmação (0 restantes). A cascata foi ensaiada no smoke local (nada sobra, outra empresa sintética intacta). Reutilizar o aprendizado anterior: o classificador de permissões já bloqueou remoção automática de linhas sintéticas — por isso a limpeza é um arquivo para o usuário.

## 6. Como executar (quando autorizado)

```bash
# 1) dry-run (não toca no banco)
node .claude/remote/order-race.mjs --n=20
# 2) execução real (somente com autorização e migrations aplicadas)
ORDER_RACE_AUTHORIZED=endbovcvhfvaynqjronl node .claude/remote/order-race.mjs --execute-remote --n=20
# parcial: --case=A,E
```
O relatório JSON fica em `.claude/remote/tmp/order-race-<run>.json`. Critério de aceite: **todos** os casos PASS; qualquer FAIL ⇒ não ligar `order_drafts_enabled` em empresa real.

## 7. Limites honestos

- A corrida depende de a barreira alinhar as sessões (skew medido, ≈ ms) — não é determinística; por isso N=20 repetições por caso.
- O caso A usa o mesmo job/mensagem nas duas sessões. Duas confirmações com **mensagens diferentes** da mesma conversa não correm em paralelo na prática (um job ativo por conversa); a sequência está coberta localmente (9.11, 14.7).
- A fixture usa o primeiro usuário já existente em `auth.users` apenas como referência de `created_by` da impressora sintética (nenhuma conta é criada ou alterada).
