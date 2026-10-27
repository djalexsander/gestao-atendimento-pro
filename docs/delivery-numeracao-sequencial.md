# Delivery e Retirada — numeração sequencial por empresa

Status: migration `20261031010000` APLICADA em produção (backfill 1..10 conferido). Release v1.0.12 (junto com troco e PDF).

## Regra
`DELIVERY #0001`, `RETIRADA #0002`, `DELIVERY #0003`: uma sequência por empresa, compartilhada pelos dois tipos. Nunca reinicia, nunca reutiliza número (inclusive de cancelado), 4 dígitos com zeros à esquerda e 10000+ mostra todos os dígitos. O UUID continua sendo a identidade interna; o código curto antigo (6 caracteres do UUID) vira só fallback/suporte.

## Banco (migration aditiva)
- `delivery_orders.order_number bigint NOT NULL` + índice único `(company_id, order_number)` + `CHECK > 0`. Fica em `delivery_orders` (1:1 com a sessão `kind='delivery'`), que todo caminho de criação (humano, IA/WhatsApp) já usa: o motor único não foi reescrito.
- `delivery_order_counters(company_id, last_number)`: RLS ligado, **sem** política e **sem** GRANT para clientes; só cresce (trigger); some apenas na exclusão da empresa.
- Alocação: trigger `BEFORE INSERT` em `delivery_orders` (`assign_delivery_order_number`, SECURITY DEFINER) com `INSERT … ON CONFLICT DO UPDATE` no contador: lock de linha por empresa ⇒ serial, sem duplicar. Sempre sobrescreve o valor recebido. Transacional: criação que falha/reverte devolve o número (sem buraco). Solicitação duplicada (`client_request_id`) devolve o pedido existente e **não consome** número.
- Imutável: trigger `guard_delivery_order_number` recusa qualquer UPDATE do número (PT409).
- Histórico: numerado por `created_at, id` por empresa (desempate determinístico); só a coluna nova é gravada (trigger de `updated_at` desligado durante o backfill; status, datas, taxa e valores intactos). Contador = maior número; empresa sem pedidos começa em 1.
- Helpers (EXECUTE fechado a anon/authenticated): `delivery_order_number_text`, `delivery_order_code`, `delivery_session_label`.
- Funções existentes ajustadas por substituição exata de trecho (contagem conferida; o `pg_temp.patch_order_number_fn` aborta se o trecho não ocorrer o número esperado de vezes): `delivery_order_summary`, `list_delivery_orders` (+ `get_delivery_order` via `to_jsonb`), `list_delivery_receivables`, `list_courier_settlements`, `list_courier_cash_pending`, `settle_courier_receipts`/`give`/`return`/`settle_courier_cash`/`resolve` (texto do pedido nos movimentos de caixa novos), `production_queue_base`/`production_history_base` (KDS), `delivery_print_block`, `print_session_header`, `enqueue_order_print_jobs`, `enqueue_cancellation_print_jobs`, `push_session_label`.
- **Não alterado de propósito:** textos do livro do Caixa “Venda - Delivery” / “Estorno - Delivery” (`close_service_session`, `refund_service_payment`) e todo valor, pagamento, estoque, produção e idempotência. Chaves antigas das respostas continuam (`short_code` passa a trazer o número formatado; `order_number`/`fulfillment` são novas).

## Telas / impressão
- Front: `lib/orderNumber.ts` (só formata e busca; nada é calculado/contado no cliente). Quadro do Delivery (cartão e detalhe), nova venda (confirmação), Pedidos (histórico), tela do atendimento no Caixa/Balcão, contas do Caixa, Acerto de entregadores e pendências de troco, KDS (cartão, histórico e aviso de cancelamento).
- Busca aceita `1`, `0001` e `#0001` (e o código técnico antigo no quadro).
- Print Agent: cabeçalho do ticket da cozinha `DELIVERY #0001` / `RETIRADA #0002`; pré-conta, comprovante e cancelamento saem com o rótulo do banco (`Delivery #0001`, `Retirada #0002`; a retirada deixa de sair como “Delivery” nas contas). Payload antigo (sem número) imprime como antes. Para o ticket da cozinha aparecer com o número é preciso o **Print Agent novo**; sem ele o ticket da cozinha segue como hoje e só os demais documentos mudam.

## Testes (locais)
- Banco: `delivery-order-number.mjs` (61 checks: sequência compartilhada, isolamento, cancelados, duplicidade, rollback sem buraco, simultâneos, imutabilidade, >9999, KDS, Caixa, impressão 80/58 mm, acerto, compatibilidade) + `delivery-order-number-backfill.mjs` (11: migration sobre banco com pedidos existentes, desempate, `updated_at` intacto, contador, continuidade) + `mutate-delivery-order-number.mjs` (31 mutantes, 31 mortos). Regressão completa: 5894 ok, 0 falhas, 0 abortadas; `acl2.mjs` OK.
- Front/Edge: 2416 ok (33 novos em `order-number-logic.mjs`). Print Agent: 139 ok, `tsc` ok. Web: `tsc` ok, `lint` exit 0 (68 avisos, sem aumento), `build` ok.
- Concorrência: PGlite é monoprocesso; a serialização é garantida pelo lock de linha do contador (UPSERT) e pelo índice único. Prova com conexões reais fica para staging/autorização.

## Riscos
1. O contador serializa a criação de pedidos **da mesma empresa** até o commit (transação curta); pedidos de empresas diferentes não se bloqueiam.
2. Ticket da cozinha com número exige o Print Agent novo.
3. App 1.0.11 instalado: segue funcionando (mostra o código curto no quadro; textos de Caixa/acerto passam a trazer o número porque o servidor devolve `short_code` formatado).
4. Pedidos históricos recebem número retroativo por ordem de criação (uma vez, na migration).

## Publicação conjunta v1.0.12 (proposta, não feita)
`db push` (dry-run antes; ordem 20261031010000) → deploy Web/PWA + Desktop (troco + numeração) → Print Agent (ticket da cozinha) → homologação: criar delivery/retirada, ver `#000N` no quadro, KDS, Caixa, impressões e acerto.
