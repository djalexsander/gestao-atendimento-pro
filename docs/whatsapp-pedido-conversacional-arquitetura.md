# Pedido conversacional no WhatsApp — auditoria e arquitetura (revisão 3, SÓ PROPOSTA)

Data: 2026-10-20 · Projeto Supabase `endbovcvhfvaynqjronl` · Piloto: Djalexeventos
Revisão 3: incorpora as decisões finais D1–D10 e as respostas P1–P4 do usuário (todas fechadas).
Nada foi implementado: sem migration, sem alteração de código, sem db push, sem deploy, sem push, sem mensagens enviadas. Apenas leituras do código e consultas somente leitura ao remoto.

---

## 0. Decisões finais (D1–D10) e o que cada uma muda na arquitetura

| # | Decisão final | Efeito principal |
|---|---|---|
| D1 | `created_by`/`opened_by` nulos + `created_via='whatsapp_ai'`, **com vínculo auditável a `conversation_id` e `draft_id`** | Colunas de canal e vínculo em `delivery_orders` (FK composta), `created_via` em sessão e pedido, CHECKs de integridade (seção C, N). |
| D2 | v1 com **RETIRADA e ENTREGA**. A IA coleta o endereço na conversa. Sem cliente previamente cadastrado. Endereço no draft, validado contra as regras/zonas antes da confirmação | O motor de delivery precisa aceitar **endereço em snapshot** e **cliente nulo** (hoje exige `customers` + `customer_addresses`). Coleta de endereço por slots; resolução de zona/taxa no banco (F.4, H). |
| D3 | A IA **pergunta a forma de pagamento** entre as autorizadas da empresa, **sem cobrar**. Dinheiro: pergunta troco e valor. Tudo é informação operacional | Lê `company_business_profile.payment_methods`; grava `expected_method`/`cash_change_for` (já existem em `delivery_orders`). Sem Pix, sem cobrança, sem confirmar recebimento (F.5). |
| D4 | **Modificadores estruturados** existentes. Grupo obrigatório: a IA pergunta e resolve **antes** da confirmação. Observação livre permitida, mas **não substitui** obrigatório | Tabela de modificadores do rascunho, resolvedor de opções por produto, item "incompleto" bloqueia o resumo (F.3). |
| D5 | Intenção clara de pedido no singular ⇒ **quantidade 1**. Pergunta informativa NÃO adiciona item. Ambiguidade real de quantidade ⇒ pergunta | Regra em duas camadas: extrator marca `intent` e guarda determinística no TypeScript (F.2). |
| D6 | Draft expira em **60 min deslizantes** desde a última atividade do cliente, sem lembrete | `expires_at` renovado por atividade do cliente; cron de expiração (E). |
| D7 | Pedido conversacional **só no AUTO**. Suggest não cria nem altera draft | Flag + guarda no handler do auto; suggest intocado (L). |
| D8 | **Resumo completo calculado pelo backend** antes da criação; só confirmação explícita cria o pedido | Template do backend com itens, modificadores, tipo, endereço/zona/taxa, pagamento, troco, subtotal e total (G). |
| D9 | **Produção pelo roteamento existente**; a IA não escolhe setor | O rascunho nem tem campo de setor; o núcleo define pelo cadastro (J). |
| D10 | **Cliente não cadastrado não é exigido**. Snapshot do contato. Vínculo só por regra segura já existente. Nunca criar/mesclar/sobrescrever cliente | Vincula **apenas** se a conversa já tiver `customer_id` definido por humano (D10 em C). Sem match automático por telefone. |

### P1–P4 — decisões finais

- **P1 (aprovado):** entrega só é confirmada quando o endereço corresponder a uma **zona ativa**. Sem zona compatível: a IA oferece retirada ou faz handoff. **Nunca** aplica automaticamente a taxa padrão (R$ 5 na Djalex) a endereço desconhecido. Taxa manual nunca é usada pela IA. Implementação: o resolvedor da IA ignora `default_fee`; **não** há flag por empresa (a regra é fixa para a IA). A RPC humana continua com a regra atual (zona, senão padrão, senão manual).
- **P2 (aprovado):** se todas as zonas ativas da empresa são da mesma cidade/UF, o backend preenche cidade/UF e **mostra no resumo** (marcado como "confirmar") para o cliente confirmar. Se há cidades diferentes, a IA pergunta cidade/UF.
- **P3 (mudado):** **sem handoff por telefone internacional.** `delivery_orders.customer_phone` passa a aceitar o padrão E.164 de até 15 dígitos. Padrão do projeto = **somente dígitos, sem `+`** (igual a `whatsapp_conversations.contact_phone`, `^[0-9]{10,15}$`; o `+` é só apresentação). Migration **aditiva** (ver C e N), com revisão de todas as validações do campo.
- **P4 (aprovado):** ao cancelar ou expirar o rascunho, endereço e observações pessoais são **limpos na própria transição**, sem retenção adicional. No pedido confirmado, o endereço fica só no snapshot operacional de `delivery_orders` (arquitetura atual).

#### P3 — revisão do campo `customer_phone` (resultado da auditoria)

| Local | Hoje | Mudança |
|---|---|---|
| `delivery_orders.customer_phone` — CHECK `delivery_orders_customer_phone_check` (`'^[0-9]{8,13}$'`) | limite artificial de 13 | **Alargar para `'^[0-9]{8,15}$'`** (DROP + ADD do CHECK; alargar nunca invalida linha existente) |
| `create_delivery_order` — validação `char_length(v_phone) not between 8 and 13` (`20261014080000:808`) | idem | Alargar para 15 **dentro da migration do núcleo** (que já recria a função). Mensagem de erro mantida. |
| `delivery_digits()` | só remove não-dígitos | **Sem mudança.** Já normaliza para dígitos (o `+` é descartado, padrão do projeto). |
| Guarda `guard_delivery_order_change` (imutabilidade do snapshot) | compara só igualdade | Sem mudança. |
| `delivery_order_summary`, impressão (`delivery_print_block`), lista, push | repassam o texto | Sem mudança; a suíte confere que 14–15 dígitos fluem até o payload. |
| Frontend: `deliveryLogic.ts` (`formatPhone`, `p_customer_phone` só dígitos), `DeliveryDetail.tsx` (`tel:`) | `formatPhone` só formata 10/11 dígitos e devolve os dígitos nos demais casos | **Sem quebra.** Melhoria opcional de apresentação: `+CC …` quando ≥ 12 dígitos e `tel:+dígitos`. Fica como ajuste visual da fase de UI. |
| Testes `delivery-orders.mjs` / `delivery-push-report.mjs` | cobrem telefone BR | Acrescentar: 14 e 15 dígitos aceitos, 16 recusado, 7 recusado, não-dígito normalizado, `+55…` normalizado. |

Fora do escopo (**não** alterados nesta fase, a decidir por você): `customers.phone`/`whatsapp`, `companies.phone`/`whatsapp`, telefone da cobrança Asaas e `customers_clean`/`company_preferences` validam `8–13`. Consequência: uma conversa internacional não pode ser vinculada a um cliente que tenha esse mesmo número cadastrado em `whatsapp` (limite de 13), mas o pedido pela IA funciona porque o snapshot de contato vem de `contact_phone` da conversa. Se quiser eliminar a limitação no cadastro de clientes também, é uma migration aditiva separada e simétrica.

---

## A. Fluxo atual de pedidos (auditado)

| Camada | Função | Arquivo | Observação |
|---|---|---|---|
| Motor único | `submit_service_order_core(p_service_session_id, p_items jsonb, p_origin, p_enqueue_print)` | `20261014080000_delivery_operations.sql:24` | SECURITY DEFINER, EXECUTE revogado dos clientes. |
| Pública (comanda/mesa) | `submit_service_order(session, items)` | idem `:304` | Invólucro do núcleo (origin por papel). |
| Pública (delivery/retirada) | `create_delivery_order(...)` | idem `:705` | Cria sessão `kind='delivery'` + pedido pelo núcleo + `delivery_orders` + eventos + impressão. **Idempotente por `client_request_id`** (lock advisory + unique por empresa). |

O motor já garante (e NÃO deve ser reescrito): produto da mesma empresa, ativo, `available_for_sale`, categoria ativa; preço sempre o `sale_price` do banco; setor efetivo `coalesce(products.production_sector_id, categoria.default_production_sector_id)`; modificadores (só ids; nome, tipo e acréscimo lidos do banco; vínculo ao produto; min/max; grupo obrigatório); quantidade inteira > 0; observação ≤ 200; ≤ 100 itens; estoque por quantidade com lock em ordem de id, baixa, `product_stock_movements` e PT409 se faltar; inserção de `service_orders`, `service_order_items` (com `production_status='pending'` e snapshots) e `service_order_item_modifiers`; impressão complementar que nunca derruba o pedido.

Produção e realtime: nada a criar. Os itens entram em `production_queue_base` (inclui o join do delivery), KDS (pending → preparing → ready), push (`push_trg_new_order`) e relatórios. Delivery só avança quando todos os itens estão `ready`.

Pagamento não faz parte do pedido: `payment_timing`, `expected_method`, `cash_change_for` são informação. O recebimento real é `close_service_session`, no Caixa, por humano.

## B. RPC oficial a reutilizar na confirmação

**`create_delivery_order`** (que chama o núcleo): única via oficial fora de comanda/mesa, já idempotente. O WhatsApp entra como **canal** do pedido de delivery (`service_orders.origin` continua `'delivery'`; o núcleo proíbe `'whatsapp'` em sessão delivery, e mudar isso não é necessário).

**Bloqueios reais encontrados:**
1. Tudo depende de `auth.uid()` e do papel do usuário. O worker usa service_role. `service_orders.created_by` e `service_sessions.opened_by` são `NOT NULL` com FK para `auth.users`. Não existe "ator sistema" ⇒ D1.
2. `create_delivery_order` (versão humana) **exige cliente cadastrado** na entrega e lê o endereço **só de `customer_addresses`**. Isso é regra da RPC, **não da tabela**: `delivery_orders` já guarda snapshot de endereço (`addr_street…addr_reference`) e `customer_id` é nulo-permitido. ⇒ D2/D10 exigem um núcleo interno que aceite **endereço em snapshot** e **cliente nulo**, mantendo a RPC humana exatamente como está.
3. `resolve_delivery_zone` e `delivery_assert_operator` também usam `auth.uid()`; a lógica de zona (`city_key`/`neighborhood_key` via `delivery_norm_text`, depois `default_fee`) precisa de uma versão interna sem `auth.uid()`.

## C. Como representar o pedido vindo do WhatsApp

Opção escolhida: **Delivery/Retirada** (nativa). Sem comanda virtual.

Estrutura:
- Sessão `kind='delivery'` (sem ponto) + `delivery_orders` com `fulfillment` `pickup|delivery`, `service_orders.origin='delivery'`.
- **Autoria (D1):**
  - `service_sessions.created_via` e `service_orders.created_via` (`'user'` default | `'whatsapp_ai'`).
  - `opened_by` e `created_by` passam a aceitar nulo **somente** com `created_via='whatsapp_ai'` (CHECK `created_by is not null or created_via='whatsapp_ai'`). Relatórios usam `LEFT JOIN profiles`, então toleram nulo.
  - **Vínculo auditável:** `delivery_orders.channel` (`'internal'|'whatsapp'`), `whatsapp_conversation_id` e `whatsapp_order_draft_id` (FKs compostas com `company_id`). CHECK: `channel='whatsapp'` ⇔ ambos preenchidos. O rascunho guarda de volta `delivery_order_id` e `service_order_id` (UNIQUE parcial). `delivery_order_events` registra o ator como nulo + payload com `draft_id`.
- **Cliente (D10):**
  - Snapshot do contato: nome = `contact_display_name` da conversa (se não houver, a IA pergunta "Em nome de quem?"), telefone = `contact_phone` (dígitos E.164, até 15; aceito após a migration do P3).
  - `customer_id` só se a conversa **já tiver** `customer_id` definido por um humano e o cliente estiver ativo. É a única regra segura que existe hoje. `whatsapp_suggest_customers` (match por telefone) é só sugestão para o atendente e **não vincula nada**. A IA nunca cria, mescla nem sobrescreve cliente.
- **Entrega (D2):** endereço do draft (colunas próprias) → ao confirmar, `delivery_clean_address` (validações já existentes: rua, bairro, cidade, UF, CEP) → snapshot em `delivery_orders.addr_*` (CHECK `delivery_shape` exige rua, bairro, cidade, UF e `estimated_delivery_at`).
- **Pagamento (D3):** `payment_timing` automático (`on_delivery` na entrega, `on_pickup` na retirada), `expected_method` e `cash_change_for` do draft. Nada de cobrança.

Estado real da Djalexeventos (somente leitura): módulos delivery, estoque, financeiro, impressão, produção e whatsapp contratados; delivery_settings com entrega e retirada ativas, `default_fee` R$ 5, 1 zona ativa; 42 produtos ativos e disponíveis, 0 sem setor efetivo, 4 com estoque por quantidade, 1 grupo de modificadores; setores Atendente, Caixa Balcão, CHURRASQUEIRA, COZINHA; 0 dispositivos de impressão ativos (a produção sai pelo KDS); 2 `delivery_orders` e 2 `service_orders` de teste antigos.

## D. Schema proposto

Todas com `company_id`, FKs compostas, RLS ligada. O cliente (app) só LÊ, por RPC, com papel operacional e módulos `whatsapp` + `delivery`. Escrita só por RPC.

**`whatsapp_order_drafts`**
- `id`, `company_id`, `conversation_id` (FK composta), `status` (`collecting|awaiting_confirmation|confirmed|cancelled|expired|failed`).
- Pedido: `fulfillment` (`pickup|delivery`), `contact_name`, `contact_phone` (snapshots), `customer_id` (nulo; só se a conversa já estava vinculada), `notes` (≤ 300).
- Endereço (entrega): `addr_street`, `addr_number`, `addr_complement`, `addr_neighborhood`, `addr_city`, `addr_state`, `addr_cep`, `addr_reference`, `addr_city_inferred boolean`, `zone_id`, `delivery_fee`, `fee_source` (`zone|default|none`), `estimated_minutes` (tudo resolvido pelo banco, nunca pelo modelo).
- Pagamento: `expected_method` (nulo ou um dos autorizados da empresa), `cash_change_for` (nulo; só com `cash`).
- Controle: `version int`, `summary_version int`, `summary_message_id`, `items_total numeric(12,2)` e `grand_total` (itens + taxa), calculados pelo banco; `last_customer_activity_at`, `expires_at`; `confirmed_at`, `confirmed_by_message_id` (UNIQUE), `delivery_order_id`, `service_order_id` (UNIQUE parciais), `failure_code`.
- **Índice único parcial: 1 rascunho aberto (`collecting|awaiting_confirmation`) por conversa.**

**`whatsapp_order_draft_items`**: `draft_id`, `company_id`, `product_id`, `product_name_snapshot`, `quantity` (1..50), `unit_price_snapshot` (**já com o acréscimo dos modificadores**), `modifiers_unit_total`, `line_total` (gerado), `notes` (≤ 200), `position`, `is_complete` (todas as exigências de grupo satisfeitas).

**`whatsapp_order_draft_item_modifiers`** (D4): `draft_item_id`, `modifier_option_id`, `group_id`, `group_name`, `option_name`, `modifier_type`, `price_delta` (snapshots lidos do banco).

**`whatsapp_order_draft_events`** (append-only): `draft_created, item_added, item_removed, item_changed, modifier_set, fulfillment_set, address_set, address_validated, payment_set, summary_sent, confirm_received, revalidated, price_changed, unavailable, order_created, handoff, cancelled, expired, failed`. Só ids, códigos e números: sem texto do cliente, sem endereço, sem raciocínio da IA.

**Flag:** `company_whatsapp_ai_settings.order_drafts_enabled boolean default false` (só tem efeito com `mode='auto'`, `knowledge_enabled=true` e módulos whatsapp + delivery). 

## E. Estados e transições

```
(nenhum) → collecting ──todas as pendências resolvidas + resumo enviado──▶ awaiting_confirmation ──confirmação válida──▶ confirmed
              ▲  │                                                          │   │
              │  └────────────── qualquer alteração (versão++) ─────────────┘   └─ preço mudou / indisponível ─▶ collecting|awaiting
collecting|awaiting ──"cancela"/"não quero mais"──▶ cancelled        collecting|awaiting ──60 min sem atividade──▶ expired
confirmed (tentativa) ──erro na criação (rollback total)──▶ awaiting_confirmation + handoff  (ou failed)
```

"Pendências" para sair de `collecting`: ao menos 1 item; todos os itens completos (grupos obrigatórios resolvidos, sem ambiguidade); `fulfillment` definido; se entrega, endereço válido com zona/taxa resolvida; se a empresa tem formas de pagamento autorizadas, `expected_method` escolhido; se `cash`, troco respondido (sim com valor ≥ total, ou não); nome do contato conhecido.

Regras:
- Trigger de guarda proíbe transições fora do grafo e qualquer UPDATE em rascunho terminal. Em `cancelled`/`expired` endereço e observações são limpos (P4).
- Qualquer alteração (item, modificador, tipo, endereço, pagamento) incrementa `version` e invalida o resumo anterior. A confirmação só vale se `summary_version = version`.
- Expiração (D6): `expires_at = last_customer_activity_at + 60 min`, renovado só por mensagem do cliente. `pg_cron` a cada 5 min marca `expired`. Sem lembrete.
- Terminais: `confirmed`, `cancelled`, `expired`, `failed`. Novo pedido ⇒ novo rascunho. Depois de `confirmed`, "cancela" ⇒ handoff humano (a IA não altera pedido oficial).

## F. Interpretação e atualização do rascunho

Princípio: **o modelo só extrai intenção; o banco resolve produto, opção, endereço, zona, taxa, preço e total.**

### F.1 Contrato do extrator
O modelo recebe: última mensagem, estado atual do rascunho (itens, modificadores, tipo, endereço, pagamento, total, pendências) e as formas de pagamento autorizadas. Devolve JSON estrito de operações: `add | remove | set_quantity | replace | set_modifier | note | set_fulfillment | set_address_field | set_payment | set_change | set_name | cancel | ask | inquiry | other`. Cada operação traz **texto livre** (menção de produto/opção, campo de endereço) e números. Nunca `product_id`, `option_id`, preço, taxa, total ou status. Campos desconhecidos são descartados.

### F.2 Quantidade e intenção (D5)
- **Pergunta informativa NÃO adiciona item**: "tem espeto de carne?", "quanto é a Coca?", "quais espetos vocês têm?" ⇒ `inquiry` (segue o fluxo atual de resposta com a base de conhecimento).
- **Intenção clara de pedido** (verbos de pedido: "quero", "me vê", "manda", "vou querer", "coloca", "adiciona", "traz", "pode ser") sem número no **singular** ⇒ quantidade **1**: "quero espeto de carne", "me vê uma Coca", "manda um pão de alho".
- Número ou numeral explícito vale: "3 espetos", "dois de carne".
- **Ambiguidade real de quantidade** ("uns espetos", "alguns", "um pouco", "meia dúzia de espeto", plural sem número como "quero espetos de carne") ⇒ a IA pergunta.
- Dupla camada: o extrator só pode emitir `add` com `order_intent=true`, **e** o TypeScript confere um verbo de pedido na mensagem (e ausência de padrão interrogativo puro). Se as duas camadas divergem, vira `inquiry` ou pergunta. Teto: 50 por item, 30 linhas.

### F.3 Produto, ambiguidade, inexistente e modificadores (D4)
- Resolvedor novo no banco (`whatsapp_order_resolve_item`, escopo por job) mapeia a menção para `product_id` reutilizando a normalização e pontuação do `whatsapp_ai_lookup_knowledge` (hoje ele devolve nomes e preços, **sem ids**). Resultado: `exact | ambiguous(candidatos) | none`.
  - `ambiguous` ("Coca" ⇒ normal ou Zero) ⇒ item **não entra**; template pergunta qual.
  - `none` ⇒ "Não encontrei esse item no cardápio. Quer que eu mostre as opções disponíveis?".
- **Modificadores estruturados:** ao resolver o produto, o banco devolve os **grupos ativos vinculados** com `min/max/selection_type` e as opções ativas (nome, tipo, acréscimo). A IA resolve a opção **somente dentro dos grupos daquele produto** (exact/ambiguous/none, mesma lógica). Grupo obrigatório (`min ≥ 1`, respeitando a regra "grupo sem opção ativa nunca trava") ⇒ item fica `is_complete=false` e o template pergunta "Qual opção de {grupo}: A, B ou C?". O rascunho **não** vai para `awaiting_confirmation` com item incompleto. O mesmo vale para max e seleção única.
- Observação em texto livre ("sem cebola", ≤ 200) é permitida e **nunca** substitui um grupo obrigatório. Se o texto casa exatamente com uma opção estruturada (por exemplo uma remoção), usa-se a opção estruturada; o resto vira nota.
- O núcleo valida tudo de novo na criação (vínculo, min/max, ativo).

### F.4 Entrega: coleta e validação do endereço (D2, P1, P2)
- Coleta por campos (rua, número, bairro, complemento opcional, ponto de referência opcional, cidade/UF conforme P2, CEP opcional). A IA pergunta só o que falta, um assunto por mensagem.
- Cada alteração chama `whatsapp_order_set_address` (banco): normaliza com `delivery_clean_address`, resolve a zona por `city_key` + `neighborhood_key` (`delivery_norm_text`), aplica a regra de taxa da IA (**zona ativa ⇒ `fee` da zona; sem zona ⇒ recusa**; `default_fee` e taxa manual nunca são usados — P1), calcula a previsão (`estimated_minutes`, `delivery_minutes`/zona) e devolve `zone_name`, `fee`, `eta`. O resumo mostra endereço, zona, taxa e previsão **do banco**.
- Sem zona compatível (P1) ou entrega desativada nas configurações ⇒ template oferece retirada ou handoff. Sem endereço válido não há resumo.

### F.5 Pagamento e troco (D3)
- Formas autorizadas = `company_business_profile.payment_methods` (`cash|pix|debit_card|credit_card|other`). Lista vazia ⇒ a IA **não pergunta** e o pedido segue sem método (informação opcional hoje).
- A IA oferece **só** as autorizadas (nomes amigáveis do template). Resposta fora da lista ⇒ pergunta de novo. **Sem cobrança**: nenhum Pix gerado, nenhuma chave enviada, nenhuma afirmação de recebimento. A frase padrão é "O pagamento é feito na retirada/entrega".
- Dinheiro: pergunta "Precisa de troco? Para qual valor?". Regras do banco: `cash_change_for` só com `cash`, ≥ total do pedido (**itens + taxa**), 2 casas decimais. Se o valor informado for menor que o total, a IA pede outro. "Não preciso de troco" ⇒ nulo.
- `payment_timing`: entrega `on_delivery`, retirada `on_pickup`. Pagamento antecipado (`on_order`) fica fora da v1.

### F.6 Resposta, resumo e roteamento
- **Resposta e resumo são montados por template no backend** com as linhas do banco; a IA não soma nem formata valores. O modelo pode, no máximo, fornecer uma frase curta de abertura/fechamento que passa pelo `checkSuggestionSafety` existente.
- Com `order_drafts_enabled=true` (e só no AUTO) o desvio atual `isOrderIntent ⇒ handoff action_required` passa a entrar no fluxo de pedido. Com a flag desligada, nada muda (zero regressão no homologado).
- Desfazer/alterar: "tira uma Coca", "troca o de frango por linguiça", "coloca mais um coração", "sem cebola" atualizam o rascunho e invalidam o resumo.
- Humano assumiu (`ai_control='human'` ou conversa atribuída): o worker não processa; o rascunho fica salvo e visível; nenhuma confirmação automática ocorre.

## G. Resumo e confirmação explícita (D8)

**Resumo completo, calculado pelo backend, antes de criar:**
```
Seu pedido — ENTREGA
2x Espeto de carne — R$ 24,00
1x Pão de alho (Com queijo) — R$ 11,00        ← modificador estruturado
   obs.: sem cebola
Subtotal: R$ 35,00
Taxa de entrega (bairro Centro): R$ 5,00
Total: R$ 40,00
Endereço: Rua X, 123 — Centro, Cidade/UF
Previsão: cerca de 45 min
Pagamento: dinheiro, troco para R$ 50,00 (pago na entrega)
Está correto? Responda CONFIRMAR para enviar o pedido ou diga o que quer alterar.
```
(Em retirada: sem taxa/endereço; "Retirada no balcão — previsão ~30 min".) Cidade/UF preenchidas pelo backend (P2) aparecem marcadas "(confirme a cidade)" no resumo.

**Classificador de confirmação — determinístico em TypeScript, sem modelo:**
- normaliza (minúsculas, sem acento, sem pontuação/emoji) e exige correspondência **exata** com lista aprovada: `confirmar`, `confirmado`, `confirmo`, `pode confirmar`, `pode mandar`, `pode enviar`, `esta correto`, `sim pode enviar`, `sim pode confirmar`, `sim esta correto`;
- recusa qualquer frase com negação/alteração (`nao`, `mas`, `tira`, `troca`, `mais`, `sem`, `acho`, `talvez`, `?`) mesmo contendo expressão da lista;
- `ok`, `beleza`, `sim`, `blz`, `👍` sozinhos **não confirmam**: a IA repete "Para enviar o pedido, responda CONFIRMAR";
- por causa do debounce (várias mensagens viram um job), só vale se a **última** mensagem do lote for a confirmação e nenhuma mensagem do lote altere o pedido;
- só vale com rascunho `awaiting_confirmation`, `summary_version = version` e o resumo **já enviado** (outbound `sent|delivered|read`) **antes** da mensagem de confirmação.

## H. Revalidação na confirmação

RPC `whatsapp_order_confirm(p_job_id, p_confirm_message_id)` (service_role, escopo por job). Em UMA transação:
1. Trava o rascunho (`FOR UPDATE`) e revalida o contexto: empresa, conversa existente e não excluída, `ai_control='inherit'`, sem atribuição, job ativo, mensagem de confirmação da mesma conversa e posterior ao resumo, rascunho aberto e não expirado, `summary_version = version`.
2. Trava os produtos do rascunho em ordem de id (mesmo padrão do núcleo) para que preço/disponibilidade não mudem até o commit.
3. Revalida contra o estado atual: produto ativo, categoria ativa, `available_for_sale`, estoque suficiente, **modificadores** (ativos, vinculados, min/max), **preço atual** (produto + acréscimos), **zona/taxa** (zona ainda ativa e taxa igual; sem zona ⇒ não confirma — P1), entrega/retirada ainda habilitada, forma de pagamento ainda autorizada, troco ≥ novo total.
   - **Preço ou taxa mudou:** atualiza o rascunho, sobe `version`, volta a `awaiting_confirmation`, evento `price_changed`, **não cria pedido**; devolve os diffs para o template "O preço de X mudou de R$ A para R$ B. O novo total é R$ C. Confirma?". Exige nova confirmação.
   - **Indisponível/sem estoque/opção inválida/zona removida:** volta a `collecting`, nenhuma criação parcial; "X não está mais disponível. Quer remover ou escolher outro?".
4. Tudo certo ⇒ chama o núcleo (I). Como defesa em profundidade, confere que subtotal e taxa gravados são iguais aos do rascunho; se divergir: ROLLBACK e `failed`/handoff.
5. Exceção do núcleo (estoque em corrida etc.) ⇒ rollback total em subtransação; resposta "Não consegui finalizar o pedido. Vou encaminhar para a equipe." + handoff. **Nunca** "pedido confirmado" antes do commit.

## I. Núcleo interno para a IA e idempotência

**Refatoração mínima e isolada** (migration própria, primeiro da fila):
- `submit_service_order_core` e `create_delivery_order` delegam para núcleos internos que recebem **ator explícito** (usuário humano **ou** `whatsapp_ai`). Funções públicas mantêm assinatura, ACL e comportamento idênticos.
- O núcleo de delivery ganha dois caminhos que a RPC humana **não** usa: (a) cliente nulo com snapshot de nome/telefone também na entrega; (b) endereço em snapshot (já limpo por `delivery_clean_address`) em vez de `customer_addresses`. A RPC humana continua exigindo cliente cadastrado e endereço cadastrado.
- Para o ator `whatsapp_ai`: sem checagem de papel de usuário; **com** `assert_company_module(delivery)` e checagem do módulo whatsapp; taxa manual proibida; `created_by`/`opened_by` nulos + `created_via='whatsapp_ai'` + vínculo de canal (D1).
- EXECUTE dos núcleos revogado de todos; só a `whatsapp_order_confirm` os chama.

**Idempotência:**
- `client_request_id` do pedido = **`draft.id`**: o lock advisory e a unicidade `(company_id, client_request_id)` já existentes garantem 1 pedido por rascunho.
- Rascunho travado `FOR UPDATE`; segunda confirmação enxerga `confirmed` e devolve `already_confirmed` (a IA responde uma vez "Seu pedido já foi confirmado" ou silencia).
- `confirmed_by_message_id` UNIQUE; `service_order_id` e `delivery_order_id` UNIQUE parciais.
- Resposta final sai por `whatsapp_ai_auto_commit_send` (única por job, nunca reenvia). Pedido criado e envio falhou: o pedido existe (visível ao atendente) e o job fecha `failed_send`.
- Corridas a testar: 2 confirmações simultâneas, webhook duplicado, worker repetido/retry após crash entre commit e resposta, 2 "confirmar" no mesmo lote e em lotes diferentes ⇒ 1 pedido, 1 baixa de estoque, 1 jogo de itens.

## J. Produção (D9)

Sem código novo. O rascunho **não tem campo de setor**. O núcleo calcula o setor efetivo pelo cadastro (produto ou categoria): Espetos ⇒ CHURRASQUEIRA, porções ⇒ COZINHA, bebidas ⇒ Caixa Balcão etc. Depois do commit, KDS em tempo real, push, fila, relatórios e impressão (quando houver dispositivo; a Djalex tem 0 hoje) seguem o fluxo existente. A IA nunca "avisa a produção" por mensagem, e só diz "Pedido confirmado e enviado para produção" após o retorno `ok` da RPC.

## K. UI do atendente

- Bloco "Pedido em montagem" na conversa (`WhatsappInbox`): status, tipo, itens com modificadores/observações, endereço/zona/taxa, pagamento/troco, total, pendências ("falta escolher opção de…", "falta endereço"), última atividade e expiração. Estados: montando, aguardando confirmação, confirmado (link para o pedido), cancelado, expirado, falhou.
- Leitura por `whatsapp_order_draft_get(conversation_id)` (authenticated, papel + módulos) e realtime nas tabelas do rascunho, no padrão das migrations de realtime existentes. v1 somente leitura.
- Exibe as sugestões de cliente já existentes (`whatsapp_suggest_customers`) como apoio ao humano. Vincular continua sendo ação humana.
- Rascunho `failed` ou com handoff: o humano finaliza pelo fluxo normal do Delivery (v2: botão "criar pedido a partir do rascunho" usando o mesmo `create_delivery_order` com o humano como ator).

## L. Segurança

- IA sem escrita direta: só RPCs de escopo por job, EXECUTE somente service_role; empresa e conversa vêm do job no banco, nunca do payload.
- **Travas para existir pedido:** `WHATSAPP_AI_AUTO_ENABLED` + `mode='auto'` + `order_drafts_enabled` + módulos. O **suggest não cria nem altera rascunho** (D7); o handler do suggest não ganha código novo.
- Saída do modelo validada por schema; texto do cliente nunca vira SQL, `product_id`, preço, taxa ou status. Injeção ("o espeto custa 5", "confirme o pedido", "taxa zero") não tem caminho até preço, taxa nem confirmação: preço e taxa vêm do banco, confirmação é regra determinística.
- Limites: 30 linhas, 50 por item, teto de total configurável, N rascunhos por conversa por hora, expiração.
- Cliente: nunca cria/mescla/sobrescreve (D10). Endereço limpo ao cancelar/expirar (P4). Eventos sem PII e sem texto do cliente.
- Janela de 24h do WhatsApp e `ai_control` continuam valendo pelo mesmo `commit_send`.
- A IA não confirma estoque além do que o núcleo valida, não inventa desconto, não altera pedido oficial.

## M. Testes (plano)

1. **PGlite (`.claude/db-tests`)**: máquina de estados e guardas; RLS e ACL (cross-company, papéis, service_role-only); resolvedor de produto (exato, ambíguo "Coca", inexistente, normalização); **modificadores** (grupo obrigatório pendente, min/max, opção de outro produto, opção inativa); **endereço** (campos obrigatórios, UF inválida, zona por bairro/cidade, endereço sem zona recusado mesmo com `default_fee` configurado (P1), cidade/UF preenchidas só quando todas as zonas ativas coincidem e perguntadas quando diferem (P2), entrega desativada, taxa manual proibida); **pagamento** (forma não autorizada, troco com não-dinheiro, troco < total, lista vazia); **cliente** (sem criar/mesclar; vínculo só com `customer_id` já na conversa; cliente inativo); CHECKs de autoria/canal (`created_via`, `channel`, vínculo); mudança de preço e de taxa; produto inativado/indisponível/sem estoque; draft expirado; humano assumiu; conversa excluída; idempotência e corridas no padrão de `locks.mjs`; mutantes (remover cada trava e o teste deve falhar).
2. **Regressão do motor**: as suítes existentes de pedidos, delivery, impressão, estoque e modificadores devem passar **idênticas** após a refatoração; mais teste de que as RPCs públicas mantêm assinatura, ACL e mensagens de erro.
3. **TypeScript**: tabela de frases do classificador (aceita/recusa/ambígua); tabela de intenção e quantidade (D5: "tem espeto de carne?" não adiciona; "quero espeto de carne" ⇒ 1; "quero espetos" ⇒ pergunta); validação do schema de operações; handler com fakes (fluxo completo retirada e entrega, retry, lote com confirmação + alteração, falha na criação, preço/taxa mudou).
4. **Remoto controlado** (padrão `ai2.mjs`): fixtures `zz-`; duas sessões confirmando ao mesmo tempo ⇒ 1 pedido; depois piloto real na Djalex, uma mensagem por vez: retirada com Coca ambígua, produto com grupo obrigatório, entrega com endereço dentro e fora da zona, "ok" (não confirma), "confirmar", conferência no KDS/setores, baixa de estoque nos 4 controlados, segundo "confirmar" sem duplicar, cancelamento antes de confirmar. Pedidos de teste do piloto são cancelados por humano pelo fluxo oficial (`cancel_delivery_order`) para não poluir relatórios.

## N. Migrations necessárias (propostas, nomes ilustrativos; NENHUMA criada)

0. `…_delivery_phone_e164` (**P3, aditiva, pequena**): `delivery_orders.customer_phone` CHECK de `{8,13}` para `{8,15}` (DROP + ADD; alargar não invalida dados). Sem outras mudanças. Vai **primeiro** porque é independente e de risco mínimo.
1. `…_order_authorship_channel` (D1): `created_via` em `service_sessions`/`service_orders`; `created_by`/`opened_by` anuláveis com CHECK; `delivery_orders.channel`, `whatsapp_conversation_id`, `whatsapp_order_draft_id` + CHECK de vínculo (a FK do draft entra depois que a tabela existir).
2. `…_order_engine_actor` (D1/D2/D10/P3): **refatoração mínima do motor** (I): núcleos internos com ator, cliente nulo e endereço em snapshot; RPCs públicas inalteradas em assinatura, ACL e comportamento; validação de telefone alargada a 15 dentro de `create_delivery_order`. Maior risco ⇒ regressão total antes de seguir.
3. `…_order_draft_foundation`: tabelas, RLS, guardas, limpeza de endereço/observações em `cancelled`/`expired` (P4), eventos, flag `order_drafts_enabled`.
4. `…_order_draft_rpcs`: resolvedor de produto/opção, `apply_ops`, `set_address` (zona **sem** `default_fee` — P1; preenchimento de cidade/UF — P2), `set_payment`, `get`, `cancel`, expiração (pg_cron a cada 5 min); tudo service_role/escopo por job (leitura da UI authenticated).
5. `…_order_draft_confirm`: `whatsapp_order_confirm` (revalidação + criação + idempotência).
6. `…_order_draft_realtime`: realtime e índices.

Edge Function: módulo novo em `_shared` (extrator, classificador de confirmação, templates), usado pelo `whatsapp-ai-auto`. Sem nova função implantada.

## O. Ordem de implementação

1. Você aprova esta revisão 3 (D1–D10 e P1–P4 já estão fechados).
2. Migration 0 (telefone E.164) + testes dedicados (14/15 dígitos aceitos, 16 e 7 recusados, normalização).
3. Migrations 1+2 (autoria e núcleo com ator) com **regressão completa** das suítes existentes.
4. Migration 3 (schema) + testes de estado, RLS, CHECKs e limpeza P4.
5. Migration 4 (resolvedor, endereço/zona sem `default_fee`, pagamento) + testes.
6. Migration 5 (confirmação) + corridas e mutantes.
7. TypeScript: extrator, classificador, templates e handler atrás da flag (suggest intocado).
8. UI do atendente (somente leitura) + realtime e melhoria opcional de exibição do telefone internacional.
9. Sincronização remota **somente com autorização expressa** (cada migration listada e confirmada antes do `db push`); validação com fixtures; piloto real controlado, uma mensagem por vez.
10. Só então ligar `order_drafts_enabled` na Djalex.

## Riscos conhecidos

- A refatoração do motor (migrations 1–2) é a parte mais sensível e mexe em código de pedido em produção: por isso vem primeiro e com regressão total. Ela ficou maior com D2/D10 (cliente nulo e endereço em snapshot na entrega).
- Extração errada pelo modelo (quantidade, opção): a rede de proteção é o resumo completo ao cliente antes de confirmar e a revalidação no banco.
- Endereço digitado livre pode não casar com a zona por grafia: pela regra P1 cai em retirada/handoff em vez de aceitar com a taxa padrão (custo: algum atrito, ganho: nunca cobrar taxa errada).
- Pedido criado e resposta final não entregue (Graph/janela): o pedido existe e a equipe o vê; o cliente pode não saber. Mitigação: card da UI e `failed_send` visível.
- Estoque é baixado na confirmação, não na montagem: o rascunho não reserva nada e pode faltar na hora de confirmar (tratado pela revalidação).

---

## P. Estado da implementação LOCAL (2026-10-20) — migrations 0 a 5 escritas e validadas em PGlite, NADA aplicado

| # | Arquivo | Conteúdo |
|---|---|---|
| 0 | `20261021010000_delivery_phone_e164.sql` | `delivery_orders.customer_phone` 8–15 dígitos (E.164 sem `+`) |
| 1 | `20261021020000_order_authorship_channel.sql` | `created_via` + autor nulo só para `whatsapp_ai` (pedido, atendimento, estoque, impressão); vínculo conversa/rascunho em `delivery_orders`; guards |
| 2 | `20261021030000_order_engine_actor.sql` | motores com ator explícito (EXECUTE para ninguém); núcleo e `create_delivery_order` viram invólucros; `enqueue_order_print_jobs` herda `created_via` |
| 3 | `20261021040000_whatsapp_order_drafts.sql` | `order_drafts_enabled` (default false); rascunho, itens, modificadores, eventos; máquina de estados; limpeza de endereço/observações ao encerrar; FK do pedido |
| 4 | `20261021050000_whatsapp_order_draft_rpcs.sql` | resolver produto/opção, `apply_ops`, `set_address`, `set_payment`, `mark_summary_sent`, `cancel`, `expire_due` (cron 5 min), leitura da UI |
| 5 | `20261021060000_whatsapp_order_confirm.sql` | `whatsapp_order_confirm`: revalidação, idempotência e criação pelo motor oficial |

Diferenças em relação ao plano (todas pequenas e justificadas):
1. **Canal:** `delivery_orders.channel` já existia (`counter|phone|whatsapp|other`); o pedido da IA usa `channel='whatsapp'` (não foi criada coluna nova).
2. **UF não é inferida:** o cadastro de zonas e o da empresa não têm UF. A cidade é inferida quando todas as zonas ativas são da mesma cidade (e fica marcada para o resumo); a UF a IA sempre pergunta.
3. **"Confirmar" repetido:** `already_confirmed` só vale para a MESMA mensagem ou até 3 mensagens do cliente depois do pedido, em 10 min, e se nenhum rascunho novo nasceu depois (evita herdar um pedido antigo numa conversa nova).
4. **Rascunho `failed`:** (decisão 2026-10-20) endereço e observações são zerados NA transição, como em cancelado/expirado/confirmado; ficam itens, snapshots, totais, motivo e ids. Sem fluxo "finalizar pelo atendente" nesta fase.
5. **Forma de pagamento:** além de obrigatória quando a empresa autoriza alguma, precisa CONTINUAR autorizada no momento da confirmação.
6. **Locks:** conversa → job → rascunho → produtos (controlados `FOR UPDATE`, demais `FOR SHARE`, sempre por id), sem upgrade de lock.

Ainda NÃO feito (próximas fases): extrator/classificador/templates em TypeScript e ligação no `whatsapp-ai-auto`; UI do atendente e realtime; teste de corrida real com sessões independentes (PGlite é um único backend); sincronização remota; ligar `order_drafts_enabled` na Djalex.
