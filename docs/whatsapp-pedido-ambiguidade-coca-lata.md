# Correção "2 coca lata" — ambiguidade de produto no pedido automático (WhatsApp)

Status: implementado e testado **localmente**; migration NÃO aplicada; nada publicado.

## Causa raiz
1. `whatsapp_order_resolve_item` exigia TODOS os termos do pedido no nome do produto. "lata" não está em "Coca-cola 350ml" nem em "COCA COLA ZERO 350ML", então "coca lata" virava `none` (a lista `near` vinha, mas o código a ignorava) e a resposta era "Quer que eu mostre as opções?".
2. O "Sim" seguinte passou pelo extrator, voltou sem operação e o fluxo caiu no fluxo de conhecimento, que respondeu `handoff/missing_info` (os prompts de conhecimento mandam usar handoff quando falta informação). O fluxo não sabia que "Sim" respondia a uma pergunta nossa.

## Solução
- **Migration `20261026010000_whatsapp_order_resolve_relaxed.sql`** (aditiva; `create or replace` de `whatsapp_order_resolve_item`, mesma assinatura): sem candidato na busca estrita, tenta de novo sem descritores genéricos (lata, latinha, gelada, geladinha, refri, refrigerante, normal, tradicional, comum); "normal/tradicional/comum" exclui zero/diet/light. O resultado relaxado nunca é `exact`: é `ambiguous` com `relaxed=true`. `none` devolve `near` sem usar os descritores. Mantém `security definer`, `search_path = public` e os GRANT/REVOKE (service_role apenas) da função original.
- **Worker** (`ai-order.ts`, `ai-order-flow.ts`): a pergunta já traz as opções reais e a quantidade pendente ("Para coca lata (2 unidades), encontrei estas opções: …"). A resposta ("Coca Zero", "normal", "2", "a segunda", ou "sim" quando há uma só opção) é resolvida sem modelo e adiciona a quantidade guardada; itens já no rascunho não são tocados. Sem entender: re-pergunta a mesma lista; na 3ª pergunta seguida encaminha com `order_unresolved`.
- "Sim" à pergunta antiga "Quer que eu mostre as opções disponíveis?" mostra as categorias reais; "sim/ok" solto com pedido em montagem repete o próximo passo (nunca cai no fluxo de conhecimento).
- Não-encontrado: "Não encontrei esse item no cardápio. Pode me dizer o nome de outro item?" (sem pergunta de sim/não).

## Política de handoff
Ambiguidade, apelido, item parecido ou variação não escolhida NÃO geram handoff. Continuam: segurança, pedido de humano, 3 tentativas seguidas sem entender a escolha (`order_unresolved`) e as regras já existentes.

## Testes
`whatsapp-order-drafts` 344, `whatsapp-order-e2e` 110, `whatsapp-order-logic` 82, `order-engine-upgrade` 21, mutação da migration 6/6 (`mutate-order-resolve-relaxed.mjs`), frontend/Edge 2267. Baselines não relacionados: `module-entitlement` G2 e o aborto de `production.mjs`.
