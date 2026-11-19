# Pagamentos parciais — E4: `replace_session_split` (divisão e substituição de divisões)

Escopo: criar e substituir a divisão de uma conta ABERTA de comanda/mesa, sempre sobre o que AINDA NÃO FOI PAGO. Só local/isolado; nada
aplicado ao remoto. As regras foram escritas ANTES do SQL e viram testes (`.claude/db-tests/partial-payments-split.mjs`, identificadores `S-n`).

## Assinatura
`replace_session_split(p_service_session_id, p_mode, p_parts jsonb, p_expected_version integer, p_client_request_id uuid) → jsonb`
- `p_mode`: `equal` | `values` | `products`.
- `p_parts` (2 a 50 partes), por modo:
  - `equal`: `[{"label":"Ana"},{"label":"Bia"},…]` — o valor de cada parte é CALCULADO (rótulo opcional; padrão "Pessoa n").
  - `values`: `[{"label":"Ana","amount":20.50},…]` — valores definidos pelo operador.
  - `products`: `[{"label":"Ana","items":[{"item_id":"…","quantity":2},…]},…]` — o valor da parte é a soma de quantidade × preço do item.
- `p_expected_version`: versão ativa que o operador viu (0 = ainda não há divisão). `p_client_request_id`: idempotência.

## Modelo (como a E1/E2 já guardam as coisas)
- Uma divisão é uma VERSÃO (1, 2, 3…); só uma ativa. Partes e itens de parte são IMUTÁVEIS; os pagamentos ficam alocados às partes em que foram feitos.
- Substituir = a versão ativa vira `superseded` (continua no banco com partes, itens e alocações) e nasce a versão seguinte. Nada é apagado nem alterado.
- Valor já pago numa parte antiga continua contando como pago (E2: `superseded_paid`); o que falta pagar volta ao "pool" e é o que a nova divisão cobre.

## Regras
- **S-1 Quem.** owner, admin e cashier (qualquer caixa; não exige caixa aberto: dividir não recebe dinheiro). attendant/production/courier: PT403. Sem vínculo, outra empresa e id inexistente: o mesmo PT404. Sem sessão: PT401. Cada pedido é validado no servidor.
- **S-2 Só comanda/mesa aberta.** Delivery e retirada: PT409. Conta fechada: PT409.
- **S-3 A divisão cobre o SALDO.** A soma das partes novas é EXATAMENTE o saldo pendente da conta no momento (`balance_due` = total vigente − aplicado). Por identidade contábil isso equivale a `total − (líquido pago nas partes antigas) − (pagamentos sem parte)`. Diferença de 1 centavo: PT400. Saldo zero ou negativo (sobra paga): PT409 "nada a dividir".
- **S-4 Só sobre o não pago.** Nenhuma parte nova pode "cobrar" valor já pago, porque a soma é o saldo. Partes antigas pagas (total ou parcialmente) ficam na versão antiga, intocadas; pagar uma parte antiga depois da substituição é recusado (E3, R-18).
- **S-5 Centavos.** Tudo em centavos inteiros. Divisão igual: `saldo ÷ n` por piso; os centavos que sobram vão +1 centavo para as PRIMEIRAS partes (ordem estável): 67,00 ÷ 3 = 22,34 + 22,33 + 22,33. Cada parte precisa de ≥ 1 centavo (saldo ≥ n centavos). Valores definidos: no máximo 2 casas, > 0.
- **S-6 Versão otimista.** `p_expected_version` é obrigatório e precisa ser igual à versão ativa atual (0 se não há). Outra versão: PT409 com a versão atual. A conta é travada (`FOR UPDATE`) — mesma trava de pagamento, pedido, cancelamento e fechamento —, então duas substituições simultâneas nunca geram duas versões iguais: uma passa e a outra recebe o conflito.
- **S-7 Idempotência.** `p_client_request_id` obrigatório. Mesma requisição com o mesmo conteúdo devolve a divisão já criada (`replay = true`), mesmo que já exista versão mais nova; conteúdo diferente: PT409.
- **S-8 Produtos: ninguém paga o mesmo item.** Cada unidade disponível pertence a UMA parte. Disponível = quantidade cobrável (quantidade − cancelada) − unidades já alocadas a partes de versões anteriores que estão QUITADAS. Unidade atribuída a duas pessoas (soma > disponível): PT409. Unidade sem dono: PT409 (a nova divisão precisa atribuir tudo). Item de outra conta ou de pedido cancelado: PT409. Parte sem item: PT400.
- **S-9 Produtos exigem pagamentos ligados a itens.** Em modo `products`, o valor das unidades disponíveis tem de ser IGUAL ao saldo. Se já há dinheiro pago que não corresponde a itens quitados (parte parcial, divisão igual/por valores, pagamento sem parte), a combinação é impossível sem "créditos" por item e é recusada (PT409) com a orientação de usar `equal` ou `values` para o saldo. (Conflito de modelagem documentado abaixo.)
- **S-10 Consumo mudou.** Pedido novo ou item cancelado depois da divisão NÃO redistribui nada sozinho: o valor aparece como "não distribuído" / "excesso" (E2) e as partes pagas ficam como estão. Quem substitui a divisão cobre o saldo atual.
- **S-11 Auditoria.** Cada operação grava 1 evento: `split_created` (não havia divisão ativa) ou `split_replaced` (havia), com versão anterior/nova, modo, saldo em centavos, partes (rótulo e valor), hash do pedido e quem fez. Nenhum pagamento, alocação ou estorno é tocado.
- **S-12 Fechamento.** O bloqueio provisório do fechamento legado (E3) continua; contas só com divisão e SEM pagamento da E3 fecham como antes.

## Conflitos de modelagem encontrados (e como foram resolvidos)
1. **Dinheiro pago x itens (modo produtos).** Uma parte parcialmente paga não tem como dizer "quais itens" o dinheiro quitou; reaproveitar os itens da parte exigiria um "crédito" por parte que o modelo (parte com valor previsto > 0 e imutável) não tem. Resolução: S-9 — produtos só quando o dinheiro já pago corresponde a partes QUITADAS cujos itens ficam travados; senão use `equal`/`values` para o saldo.
2. **Pessoa não tem identidade entre versões.** Partes são imutáveis e a pessoa é só o rótulo; ao refazer, a "mesma" pessoa vira uma parte nova na versão seguinte (a quitada some da nova, a parcial reaparece pelo que falta). A tela deve ligar versões pelo rótulo. Alternativa futura: coluna `person_key` (não feita: mudaria o esquema da E1).
3. **Pessoa que já pagou tudo não entra na nova versão** (parte com valor 0 é proibida pelo esquema): fica visível na versão antiga/histórico.
4. **Estorno em parte antiga** devolve o valor ao pool: aparece como "não distribuído" até a próxima substituição (E6 decidirá a tela; o banco já soma certo).
5. **Desfazer a divisão** (voltar a "conta inteira") não existe nesta etapa: `replace` sempre deixa uma divisão ativa. O esquema permite (uma divisão pode ficar sem sucessora); fica para decisão.
6. **Mínimo de 2 partes**: uma divisão de 1 pessoa não faz sentido e é recusada.
