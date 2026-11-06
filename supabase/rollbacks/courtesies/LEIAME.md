# Rollback das migrations de cortesias (20261115 a 20261122)

Estes arquivos **não são migrations**: ficam fora de `supabase/migrations`, então `supabase db push` nunca os aplica. São scripts
manuais, escritos para desfazer cada migration de cortesia **na ordem inversa**. Foram validados só em banco descartável (PGlite);
a repetição em PostgreSQL real faz parte do checklist de homologação (`docs/cortesias-homologacao-checklist.md`).

## Ordem (sempre do último para o primeiro)

| Passo | Arquivo | Desfaz | Depende de ter sido desfeito antes |
|---|---|---|---|
| 1 | `20261122010000_courtesy_alerts_tenant_access.rollback.sql` | 5C-3: alertas F1 (`master_get_courtesy_counters`, `master_list_courtesy_attention`) e `tenant_get_access_state` | — |
| 2 | `20261121010000_courtesy_preserved_access.rollback.sql` | F1: preservação em `pending_payment` (`company_write_blocked`, `company_entitlement`, 2 helpers) | 1122 |
| 3 | `20261120010000_courtesy_expiry_cycle.rollback.sql` | vencimentos/ciclo (`run_billing_cycle`, contadores, atenção) | 1121 |
| 4 | `20261119010000_courtesy_bridge.rollback.sql` | ponte de acesso Pix (`courtesy_access_bridges`) | 1120 |
| 5 | `20261118010000_courtesy_conversion.rollback.sql` | conversão (colunas novas, guarda de contratação, patches) | 1119 |
| 6 | `20261117010000_courtesy_billing.rollback.sql` | cortesias no faturamento (`courtesy_billing_records`, 5 patches de cursor) | 1118 |
| 7 | `20261116010000_courtesy_entitlement.rollback.sql` | entitlement/estado `courtesy` | 1117 |
| 8 | `20261115010000_company_courtesies.rollback.sql` | tabelas e RPCs base | 1116 |

Fora de ordem o banco **recusa** (ex.: `cannot drop table company_courtesies because other objects depend on it`) e, dentro de
transação, nada fica alterado. Não pule passos: a 1117 e a 1118 restauram funções por texto e dependem do estado deixado pelo passo anterior.

## Como usar

1. **Antes**, rode o pré-flight (`supabase/preflight/courtesies/courtesy-preflight.sql`) e guarde o resultado: ele diz até que etapa está aplicado.
   Faça um snapshot de ACL/funções (`.claude/remote/acl-snapshot.mjs`) para comparar depois.
2. Rode **cada** arquivo dentro de uma transação explícita, um por vez, parando no primeiro erro:

   ```sql
   begin;
   -- conteúdo do arquivo do passo N
   commit;   -- ou rollback; se algo estranho aparecer
   ```

   Por arquivo, pela CLI (somente quando o alvo for um banco de homologação/autorizado):

   ```bash
   node node_modules/supabase/dist/supabase.js db query --linked -f supabase/rollbacks/courtesies/20261120010000_courtesy_expiry_cycle.rollback.sql
   ```

   Os arquivos **não têm barra invertida** de propósito (a CLI `db query` a consome e mudaria as expressões regulares). O teste
   `scripts/courtesies/test-rollback.mjs` falha se alguma voltar a aparecer. Se a sua ferramenta não envolver o arquivo numa
   transação, coloque `begin;` e `commit;` você mesmo.
3. **Depois de cada passo**, rode o pré-flight de novo: o veredito deve mostrar a etapa anterior (`partial`, `observed_stage` = N−1) e,
   no passo 8, `ready` (etapa 0).
4. Para reaplicar depois de um rollback total, use as migrations normais (`db push`); o teste prova que elas reaplicam e reproduzem o schema.

## O que é perdido (por passo)

* **1122** — o painel do Master deixa de listar/contar a F1 e o app do tenant deixa de receber `courtesy_preserved` e `bridge_until` (o front cai no texto genérico). Não altera dados.
* **1121** — empresas em `pending_payment` de OUTRO plano com cortesia de plano aberta voltam a ficar bloqueadas e sem os módulos da cortesia imediatamente. Não altera dados.
* **1120** — a reconciliação por ciclo; cortesias já materializadas como `expired_pending_decision` permanecem.
* **1119** — o registro das pontes. Assinaturas `pending_payment` voltam a bloquear a escrita **imediatamente**.
* **1118** — autorização de conversão, início de cobrança e vínculo `converted_subscription_id`. Cortesias `converted` voltam a valer pela regra antiga.
  A restrição de tipos de evento é validada se não houver eventos `conversion_authorized`/`converted`; se houver, fica `NOT VALID` **de propósito**
  (a tabela de eventos é append-only), até o passo 8 apagá-la.
* **1117** — `courtesy_billing_records` (histórico de isenções). Competências que haviam sido isentas voltam a ser cobradas no próximo ciclo.
  Faturas já emitidas, inclusive com itens `adjustment`, não são alteradas.
* **1116** — cortesias abertas deixam de conceder módulos/estado `courtesy`.
* **1115** — **todo** o histórico de cortesias e eventos.

Nunca altera assinaturas, faturas, preços, trials, overrides ou catálogo. Faça backup/ponto de restauração antes de usar em qualquer banco com dados reais.

## Limitações conhecidas

* Não são idempotentes: repetir um passo já desfeito dá erro (por exemplo, `alter function … rename`) — em transação o erro não deixa efeito parcial.
* Os passos 1117 e 1118 restauram funções por substituição de texto sobre a definição **atual**. O 1117 falha (`rollback: patch não encontrado`) se o trecho
  não existir; o 1118 **não** verifica e seria um no-op silencioso numa função alterada por fora. Por isso, rode o pré-flight antes (ele aponta a deriva)
  e confira o veredito depois de cada passo.
* Em PostgreSQL real ainda é preciso confirmar o comportamento transacional da CLI `db query` com arquivos de vários comandos (item H-ROLL no checklist).
