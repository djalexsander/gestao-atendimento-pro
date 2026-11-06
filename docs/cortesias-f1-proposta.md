# Cortesias — F1: contratação de OUTRO plano durante cortesia de plano aberta

**Status: IMPLEMENTADA localmente na Etapa 5C-1** (migration `20261121010000_courtesy_preserved_access.sql`, rollback `supabase/rollbacks/courtesies/20261121010000_courtesy_preserved_access.rollback.sql`;
nada aplicado no remoto). As seções 1–7 abaixo são a auditoria/proposta da Etapa 5B, preservadas como registro; a seção 0 resume o que foi decidido e entregue.

## 0. Decisões finais e entrega (5C-1)

Regra implementada (toda **derivada**, nada é gravado; sem novo estado financeiro; sem mudança de frontend):

* A janela vale quando a assinatura vigente está em `pending_payment` **e** existe cortesia de **plano** aberta (`active` ou `expired_pending_decision`) de **plano diferente**
  do da assinatura **e** não há ponte de acesso ativa (a ponte 2C tem prioridade).
* Efeito: `company_write_blocked = false`; `company_entitlement` com `mode = 'courtesy_pending_payment'` e **somente**: módulos ativos do plano em cortesia
  + cortesias de módulo abertas + overrides válidos (precedente da ponte 2C). Nunca módulos do plano novo nem extras não pagos. `company_access_state` segue `pending_payment`.
* Sem prazo adicional automático: dura enquanto a cortesia estiver aberta, inclusive vencida (`expired_pending_decision`).
* Termina sozinha, voltando às regras normais: pagamento da inicial (`active`), cancelamento da pendente (estado `courtesy` normal), encerramento manual da cortesia, ou
  qualquer outro estado (`restricted`, `suspended`, inadimplência).
* Fora da janela, nada muda. Em especial, **a regra geral continua valendo**: `pending_payment` comum (sem cortesia de plano aberta de outro plano) **não recebe overrides**
  (`20261014110000`) nem cortesia de módulo (regra 4 da `20261116010000`). Cortesia só de módulo **não** abre a janela. Trial não é preservado.
* **Exceção registrada à regra "pending_payment nunca recebe override":** autorizada explicitamente na 5C-1, vale **somente** dentro da janela acima, seguindo a ponte 2C.
* Cortesia aberta do **mesmo** plano da assinatura pendente não abre a janela (segue a regra de conversão).
* Não altera fatura inicial, cobrança, Pix, Asaas, webhook, ativação (`pending_payment → active` continua exigindo a inicial paga), ponte nem cron.

Testes: `.claude/db-tests/courtesies-preserved.mjs` (45 verificações), `mutate-courtesy-preserved.mjs` (18 mutantes), `scripts/courtesies/probe-f1.mjs` (12), mais pré-flight e rollback regenerados para 7 migrations.

Efeitos visíveis que ficam para a etapa de frontend (não alterado agora): o modo `courtesy_pending_payment` cai no texto padrão do painel Master (não está em `ENTITLEMENT_MODE_TEXT`),
e `accessStateLabel` mostra "Aguardando pagamento — ponte de acesso ativa" para `pending_payment` com escrita liberada, o que também descreve a janela da F1 (impreciso: não há ponte).

---

**(Registro da 5B) Status: AUDITORIA E PROPOSTA.** Esta rodada só mediu o comportamento então vigente e desenhou a solução.
Evidência executável original: `node scripts/courtesies/probe-f1.mjs` — hoje a sonda mostra o comportamento **depois** da correção; as tabelas da seção 1 descrevem o **antes**.

## 1. O que acontece hoje (medido)

Cenário: empresa sem assinatura, trial vencido, **cortesia do plano A** aberta (estado `courtesy`, escrita liberada, módulos do plano A).
O Master contrata o **plano B** (`master_subscribe_company`, plano diferente do da cortesia).

| Momento | Estado de acesso | Escrita | Módulos |
|---|---|---|---|
| Com a cortesia A | `courtesy` | liberada | os do plano A |
| B contratado, fatura inicial **não paga** | `pending_payment` | **bloqueada** | **nenhum** |
| B paga | `active` | liberada | os do plano B (a cortesia A não concede nada em paralelo) |
| B cancelada (cortesia A ainda aberta) | `courtesy` | liberada | os do plano A |

Outros fatos medidos:
* A cortesia A continua `active` (dormente); nada a encerra ou converte.
* Nenhuma ponte Pix é criada (a ponte só nasce na conversão do **mesmo** plano) e a fatura inicial de B é a única fatura (integral, aberta).
* `pending_payment` **não entra no ciclo de inadimplência** (carência/restrição não agem nele), então o bloqueio dura **até B ser paga, anulada ou cancelada** — pode ser indefinido.
* Cortesia de **módulo** também some enquanto houver `pending_payment` (regra 4 da etapa 2A).
* Contratar o **mesmo** plano da cortesia sem conversão autorizada é recusado (PT409) — não é F1.
* Se a empresa está em **trial**, contratar B já bloqueia tudo hoje, com ou sem cortesia (regra anterior às cortesias, não é F1).

**Causa:** `company_access_state` devolve o status da assinatura vigente antes de olhar cortesias, e a 2A decidiu que cortesia nunca reativa `pending_payment`
(para uma cortesia não mascarar uma contratação/dívida). A ponte da 2C resolve só a conversão do mesmo plano. Resultado: a empresa **perde os direitos que já tinha**
no instante em que o Master contrata um plano diferente, mesmo sem ter recebido nada do novo plano.

## 2. Requisitos (da rodada 5B)

1. Preservar **temporariamente apenas** os direitos da cortesia original.
2. **Não** liberar módulos do novo plano antes do pagamento.
3. **Não** criar ponte Pix indevida.
4. **Não** contornar a ativação financeira (`pending_payment → active` continua exigindo a fatura inicial paga).

## 3. Opções avaliadas

| | Ideia | Atende 1–4? | Mudança de acesso | Observação |
|---|---|---|---|---|
| **A (recomendada)** | Preservação **derivada** dos direitos da cortesia enquanto a assinatura estiver `pending_payment` | sim | sim (2 funções) | Sem escrita, sem job, sem ponte; reversível |
| B | Recusar contratar outro plano enquanto houver cortesia de plano aberta, sem decisão explícita do Master (encerrar/converter antes) | parcial | não | Evita a surpresa, mas a empresa ainda perde o acesso (agora de propósito). Bom **complemento** da A, não substituto |
| C | Estender a ponte da 2C para troca de plano | **não** | sim | Liberaria os módulos do plano novo antes do pagamento e criaria ponte Pix indevida (viola 2 e 3) |
| D | Conceder cortesia nova do plano B e converter | não | sim | Decisão comercial (B de graça) e usa ponte; não é correção técnica |

## 4. Proposta A em detalhe

**Regra (toda derivada, nada é gravado):** a empresa tem acesso por cortesia durante `pending_payment` quando **todas** as condições valem:

1. a assinatura vigente da empresa está em `pending_payment` (nunca `past_due`/`grace`/`restricted`/`suspended`);
2. existe cortesia **aberta** (`active` ou `expired_pending_decision`);
3. para cortesia de **plano**: o plano da assinatura é **diferente** do plano da cortesia (mesmo plano segue a regra de conversão/ponte);
4. a empresa não tem ponte ativa (a ponte tem prioridade, comportamento atual).

**Efeito:**
* `company_access_state` **continua** `pending_payment` (cobrança, Asaas, telas de pagamento e Master não mudam).
* `company_write_blocked` → `false` nessa janela.
* `company_entitlement` → `mode = 'courtesy_pending_payment'`, e `modules` = **somente** os direitos da cortesia: módulos do plano da cortesia (catálogo vigente, `plan_modules`),
  mais cortesias de módulo abertas, mais overrides ativos. **Nunca** `subscription_modules` da assinatura nova.
* Termina sozinha: pagamento (vira `active`; cortesia A fica dormente como hoje) · cancelamento/anulação · encerramento da cortesia pelo Master · assinatura que saia de
  `pending_payment` para qualquer outro estado bloqueado.

**Como cada requisito é garantido**
1. Só direitos da cortesia: a lista de módulos é montada a partir de `company_courtesies`/overrides, sem consultar a assinatura nova.
2. Nenhum módulo de B: teste de invariante — nenhum código que só exista em B aparece em `modules` antes do pagamento.
3. Sem ponte: não escreve em `courtesy_access_bridges`; teste: contagem de pontes = 0 após contratar B.
4. Sem contornar a ativação: não toca `subscriptions`, `invoices`, `billing_jobs` nem o gatilho que exige a inicial paga; teste: status segue `pending_payment`, fatura inicial intacta, `master_mark_invoice_paid` continua sendo o único caminho para `active`.

**Superfície de mudança (futura migration, por exemplo `20261121010000_courtesy_preserved_access.sql`):**
* helper `courtesy_preserved_info(company)` (DEFINER, EXECUTE fechado) que aplica as quatro condições;
* `company_write_blocked` (exceção, no mesmo molde da ponte da 1119) e `company_entitlement` (ramo novo, antes do ramo do plano da cortesia);
* `tenant_get_access_state`/`tenant_get_billing_state` passam a expor `courtesy_preserved: true` (campo novo; clientes antigos ignoram) para o banner;
* `master_get_courtesy`/listas: indicador "acesso preservado enquanto aguarda pagamento";
* frontend (etapa própria): aviso no formulário de contratação do Master ("esta empresa tem cortesia do plano X; contratar o plano Y mantém o acesso da cortesia até o pagamento")
  e banner do cliente. Fora do escopo de agora.
* pré-flight/manifest: regenerar (`gen-preflight.mjs`) e acrescentar rollback 1121.

**Testes necessários (a escrever na implementação):** os 12 do `probe-f1.mjs` invertidos onde marcado `[ATUAL]`; cortesia de módulo; cortesia expirada pendente de decisão;
assinatura `restricted`/`suspended`/`past_due` **não** preserva; mesmo plano **não** preserva (vai pela conversão); ponte ativa tem prioridade; trial não é preservado;
pagamento/cancelamento/anulação encerram a janela; empresas vizinhas isoladas; concorrência pagamento × leitura; mutantes para cada condição; regressão completa; ACL do helper.

## 5. Riscos e pontos de atenção

* **Janela indefinida:** `pending_payment` não expira. Os direitos preservados são os mesmos que a cortesia já dava sem assinatura, então não há ganho novo — mas
  a janela fica aberta enquanto o Master não pagar/cancelar B. Mitigação possível: alerta no painel de atenção ("contratação pendente há N dias com cortesia aberta").
* **Escrita liberada em `pending_payment`:** é o mesmo mecanismo da ponte; o conjunto de módulos continua sendo o filtro real das telas e da IA. Auditar todo consumidor que
  decida por `company_write_blocked` sem consultar `company_entitlement` (a 5A não achou nenhum fora das RPCs; reconfirmar na implementação, incluindo Edge Functions de WhatsApp).
* **Caminho do tenant (`billing_subscribe_company`):** o próprio cliente também pode contratar outro plano. A proposta vale para os dois caminhos (a regra é de leitura).
* **Cortesia vencida:** continua aberta até decisão manual (regra existente); a proposta não muda isso.
* **Cobrança:** nada muda para a fatura de B; a cortesia do plano A não isenta B (só isenta o mesmo `plan_id`).
* **Reversão:** restaurar as duas funções e remover o helper; nenhum dado a desfazer.

## 6. Decisões que precisam ser suas antes de implementar

1. A preservação deve valer **só em `pending_payment`** (proposta) ou também em outros estados bloqueados? (Recomendo só nesse; `restricted`/`suspended` indicam dívida.)
2. Pôr **teto de dias** (por exemplo 15) para a janela, voltando a bloquear depois? Exigiria um prazo gravado ou derivado da data da assinatura. Sem teto é mais simples.
3. **Cortesia de módulo** também deve ser preservada? (Proposta: sim, é "direito da cortesia".)
4. **Trial em andamento** é preservado quando B é contratado? (Hoje não; proposta: não — só cortesia.)
5. Além da A, adotar também a opção **B** como aviso (sem bloquear) no formulário do Master?
6. Aviso ao **cliente** (banner) na mesma entrega ou em etapa de frontend separada?

## 7. Etapas sugeridas (nenhuma iniciada)
1. 5C-F1a: migration + testes + mutantes + rollback + regeneração do pré-flight (local).
2. 5C-F1b: frontend (aviso Master e banner do cliente) e testes de UI.
3. Homologação em ambiente isolado (itens H-BILL, H-CONC e novos itens F1 no checklist).

---

## 8. Etapa 5C-2 — frontend (entregue) e o que ficou só como proposta

**Entregue (somente frontend; nenhuma migration, regra de acesso ou cobrança mudou):**
* Rótulo PT-BR do modo `courtesy_pending_payment`; o rótulo do estado de acesso deixou de afirmar "ponte" só por `write_blocked`.
  Na lista de empresas, `pending_payment` com escrita liberada agora mostra: **ponte 2C** com o **prazo real** (`until_at` de `master_list_courtesy_bridges`),
  **cortesia original preservada** (consulta de pontes OK e nenhuma ponte ativa) ou texto **neutro** quando a consulta de pontes não existe/falha.
* Detalhe da empresa: aviso "Cortesia original preservada enquanto outro plano aguarda pagamento" (sem prazo de ponte), só com assinatura `pending_payment`,
  cortesia de plano aberta de plano diferente e consulta de pontes OK sem ponte ativa (dados reais já lidos das RPCs; a decisão continua sendo do banco).
  Ponte ativa: prazo real + aviso de que a operação será bloqueada se vencer sem pagamento.
* Tenant: o banner/Meus Planos deixou de dizer "Pagamento necessário para liberar a operação" quando `write_blocked = false`
  (agora: "operando com acesso temporário"), **sem prazo**.
* Compatibilidade: sem as RPCs de cortesia o recurso fica indisponível, nenhuma chamada extra de pontes é feita e o rótulo fica neutro.

**Banner do tenant com o prazo da ponte — NÃO implementado (dado não disponível com segurança).** `tenant_get_access_state` devolve só estado, `write_blocked`, `is_owner` e datas de teste/carência;
não existe campo de prazo da ponte nem de cortesia preservada, e o tenant não pode ler `courtesy_access_bridges` (RLS fechada, correto). Proposta (migration nova, futura):
`tenant_get_access_state` passa a incluir `bridge_until` (timestamp, só quando a ponte está ativa e a empresa é a do usuário) e `courtesy_preserved` (boolean). Nada além disso
(sem valores, sem ids de fatura). O front então mostraria "acesso temporário até dd/mm hh:mm" para a ponte e "acesso mantido pela cortesia" para a F1.

**Alertas da F1 sem teto — insuficientes hoje.** Medido por `scripts/courtesies/probe-f1-alerts.mjs`:
* Cortesia longe de vencer + outro plano pendente: **nenhum** alerta, contador ou item na lista de atenção (lacuna).
* Cortesia a ≤ 7 dias do fim: aparece como `expiring_soon`, mas sem citar a contratação pendente.
* Cortesia vencida: aparece como `expired_pending_decision` (cobre depois do vencimento), também sem citar a contratação pendente.
* Os contadores não têm campo para "contratação pendente com cortesia preservada".

**Proposta de RPC/migration (não implementada; exige autorização):** acrescentar a `master_list_courtesy_attention` o tipo `preserved_pending_payment`
(derivado de `courtesy_preserved_info`, com `days_pending` = dias desde a criação da assinatura pendente e o nome do plano pendente) e a `master_get_courtesy_counters`
o campo `preserved_pending_payment`. Frontend (etapa posterior): filtro/KPI "Cortesia preservada aguardando pagamento" e selo na lista de empresas.
Escolha de política a decidir junto: alerta a partir de N dias (sugestão: 7) e urgência crescente. Não altera acesso nem cobrança.

---

## 9. Etapa 5C-3 — alertas da F1 e acesso temporário do tenant (IMPLEMENTADA localmente)

Migration `20261122010000_courtesy_alerts_tenant_access.sql` (aditiva, só leitura) + rollback versionado:
* `master_list_courtesy_attention`: novo tipo **`preserved_pending_payment`** — toda F1 efetivamente ativa (derivada de `courtesy_preserved_info`), **independentemente da data de vencimento da cortesia**,
  sem teto, **uma linha por empresa**, mais antiga primeiro, com `pending_plan_name`, `pending_since` e `days_pending`. Entra em `all` entre as vencidas aguardando decisão e as que vão vencer.
  Os três tipos antigos continuam idênticos (provado por comparação antes × depois).
* `master_get_courtesy_counters`: `preserved_pending_payment` e `preserved_pending_oldest_days`.
* `tenant_get_access_state`: `courtesy_preserved` (boolean) e `bridge_until` (timestamptz ou null), explícitos, só da empresa do usuário; nenhum id, valor ou dado administrativo.

Frontend: Painel Master (KPI, filtro, linha e selo; "—" quando o backend não tem o campo), lista de empresas (rótulo com dado explícito), banner do tenant e Meus Planos
(ponte: data/hora real + aviso de bloqueio; F1: mensagem de cortesia preservada sem prazo e sem prometer acesso após encerramento manual ou ativação do plano; ambiente antigo: texto genérico).
Não altera entitlement, `write_blocked`, cobrança, Pix, Asaas, webhook, ativação nem cron; não há limite automático para a F1.
