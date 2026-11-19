# Pagamentos parciais — E5: excedente e alocação entre partes (auditoria E3/E4 + o que muda)

Escopo: regras de excedente e alocação de pagamentos entre as partes de uma conta dividida. Só local/isolado; nada aplicado ao remoto.
A auditoria abaixo foi feita ANTES de alterar o SQL, para não duplicar lógica nem criar uma segunda via de pagamento.

## 1. Auditoria: caminhos que gravam pagamento / alocação
| Caminho | Grava pagamento | Grava alocação | Conhece divisão |
|---|---|---|---|
| `register_service_payment` (E3) | sim (`client_request_id`) | sim (partes da divisão ativa) | **sim** |
| `close_service_session` (fechamento antigo) | sim (`client_request_id` nulo) | **não** | não |
| `receive_delivery_order` | via `close_service_session` | não | não (delivery nunca tem divisão) |
| `replace_session_split` (E4) | não | não | sim (só divide o saldo) |
Conclusão: **existe UMA via de pagamento parcial e UMA de alocação** (E3). O fechamento antigo é a única outra via de dinheiro e não sabe de partes: o gatilho provisório da E3 o bloqueia nas contas com pagamento da E3; numa conta dividida SEM pagamento da E3 ele ainda fecha (as partes ficam "pendentes" no histórico embora a conta esteja paga). Isso é uma decisão pendente (seção 5), não algo que o E5 cria.
**Por isso a E5 NÃO cria RPC de pagamento nova**: estende `register_service_payment` no lugar (mesma assinatura, `create or replace`).

## 2. Regras pedidas x o que já existia
| # | Regra | Estado | Onde |
|---|---|---|---|
| 1 | Pagar mais que o saldo da própria parte, até o saldo da conta | já existe (via alocações confirmadas) | E3 R-14; teto = saldo da conta (R-7) |
| 2 | Confirmação expressa para excedente a outras partes | já existe (`p_confirm_allocation = true`; com `p_part_id` o excedente é recusado) | E3 R-14 |
| 3 | Alocações explícitas somando EXATAMENTE o valor | já existe (PT400 se não somam) | E3 R-14 |
| 4 | Nunca distribuir automaticamente | já existe (sem parte/alocação com divisão ativa: PT400) | E3 R-12 |
| 5 | Não alterar o já confirmado | já existe (gatilhos de imutabilidade) | E1 |
| 6 | Sem cobrança duplicada nem alocação acima do pendente da parte | já existe (pendente por parte + gatilho deferido) | E3 R-14/R-18, E1 |
| 7 | Histórico, identificação da parte e auditoria | **parcial** (evento guarda os ids das partes, sem rótulo/versão/antes-depois) | **E5-1** |
| 8 | Pagamentos anteriores à divisão | já existe (E4 divide o saldo; E2 conta os sem parte) | E2/E4 |
| 9 | Partes quitadas visíveis no histórico | **lacuna**: o estado agregado só lista a divisão ATIVA; partes de versões antigas não aparecem | **E5-2** |
| 10 | Excedente não cobre parte sem identificá-la | já existe (cada parte vem pelo id na alocação) | E3 R-14 |
Lacuna extra achada na auditoria: **idempotência com alocações** — a réplica da mesma requisição comparava conta, forma, valor, operador e entregue, mas NÃO a parte/alocações; repetir o `client_request_id` com outra parte devolvia o pagamento original em silêncio (**E5-3**).

## 3. O que a E5 muda (e só isso)
- **E5-1 Auditoria completa.** O evento `payment_registered` passa a guardar, além do que já tinha: `allocations_detail` (por parte: id, rótulo, valor, pendente antes e depois), `split_version`, `parts_touched`, `excess_to_other_parts` (verdadeiro quando o pagamento toca mais de uma parte), `balance_after` e `alloc_hash`. Os campos antigos continuam iguais.
- **E5-2 Histórico visível.** Nova RPC somente leitura `get_session_split_history(sessão)` (owner/admin/cashier): TODAS as versões da divisão, com as partes, itens, previsto/pago/pendente e status por parte — partes quitadas de versões substituídas continuam aparecendo.
- **E5-3 Idempotência com alocações.** A réplica só vale se a parte/alocações/confirmação forem as mesmas (hash gravado no evento); com outra alocação: PT409.
- Nada mais: as regras de excedente (R-12 a R-18 da E3) permanecem exatamente como estão; os testes da E3/E4 continuam válidos.

## 4. Regras novas (E5-n)
- **E5-R1** Pagamento repetido (mesmo `client_request_id`) com parte, alocações ou confirmação diferentes: PT409 e nada muda.
- **E5-R2** O evento de cada pagamento com divisão traz o rótulo e a versão da divisão e o pendente de cada parte antes/depois; `excess_to_other_parts` é verdadeiro sse há mais de uma parte.
- **E5-R3** `get_session_split_history`: papéis owner/admin/cashier (PT403 outros; PT404 sem vínculo/outra empresa); devolve todas as versões em ordem, partes com previsto, pago líquido (alocado − estornado), pendente e status (`pending|partial|paid`); só leitura (STABLE), sem listar pagamentos individuais.

## 5. Decisão pendente (não alterada nesta etapa)
**Fechamento antigo de conta dividida sem pagamento da E3.** Hoje fecha (preservando "o fechamento tradicional"), mas paga a conta fora das partes. Duas opções para você decidir:
(a) manter (as partes ficam "pendentes" no histórico de uma conta já paga); ou
(b) estender o bloqueio provisório da E3 para contas com divisão ATIVA, até a E8 (quem dividiu precisa pagar pela E3).
Recomendação: (b), porque é a única outra via de dinheiro que ignora as partes.

## 6. Decisão tomada (opção B): bloqueio provisório ESTENDIDO — E5-4
Aprovada pelo usuário. O gatilho `service_sessions_guard_partial_close` (o mesmo da E3) passa a negar o fechamento antigo (`close_service_session`
ou UPDATE direto) de comanda/mesa em DOIS casos, ambos sem exceção:
1. a conta tem ao menos 1 pagamento da E3 (`client_request_id` preenchido), qualquer que seja o saldo ou a versão da divisão (mensagem "já recebeu pagamento parcial");
2. a conta tem DIVISÃO ATIVA, mesmo sem nenhum pagamento (mensagem "tem divisão ativa").
- **Mesma transação:** o gatilho roda no UPDATE que fecha a conta, dentro da RPC antiga; o PT409 desfaz tudo (pagamentos e movimentos de caixa inseridos antes, e o estado da conta).
- **Não interfere em:** contas sem divisão ativa e sem pagamento da E3 (fechamento tradicional), delivery/retirada, contas já fechadas, nem em outros UPDATEs da conta.
- **close_service_session não foi alterada** (corpo idêntico); só o corpo do gatilho mudou (assinatura e gatilho iguais).
- **PROVISÓRIO:** será substituído na **E8** pelo encerramento correto (saldo zerado, ciente de partes) e o gatilho removido. Consequência até lá: uma conta dividida só encerra depois da E8 (quem divide paga pelas partes). O rollback da E5 restaura o corpo exato da E3.
- Testes: unitários (`partial-payments-excess.mjs`, seção 13), corrida real (C24 a C26 e invariante), mutantes (gatilho desligado, só pagamento, só divisão, estendido a delivery, divisão substituída conta como ativa).
