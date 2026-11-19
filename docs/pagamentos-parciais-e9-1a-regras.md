# E9.1A — Chave por empresa também na escrita e rollback seguro (local; nada no remoto)

Migration `supabase/migrations/20261215020000_partial_payments_write_gate.sql`. Rollback `supabase/rollbacks/partial-payments-write-gate/rollback.sql`. Ajuste: `supabase/rollbacks/partial-payments-read-model/rollback.sql` (E9.1).

## Auditoria das RPCs de escrita (E3–E8)
Gravam pagamento parcial, alocação, divisão/parte, estorno de conta aberta ou evento `session_closed` e o cliente as executa: **somente** `register_service_payment`, `replace_session_split`, `refund_open_session_payment` e `close_settled_service_session`. Todas ganham a trava. O resto (funções internas, gatilhos) não tem EXECUTE para o cliente; nenhuma outra função chama as quatro por dentro; o cliente não tem DML nas tabelas.
Legado intocado e sem a trava: `close_service_session`, `refund_service_payment`, `receive_delivery_order`, motor de pedidos, cancelamento, caixa. As leituras (`get_session_*`) também seguem sem a trava (não gravam).

## A trava
`partial_payments_assert_enabled(empresa)` (interna, EXECUTE fechado para todos): PT403 "Este recurso não está habilitado para a empresa" se a empresa não tem o módulo `partial_payments` (override ativo/não vencido). Posição: depois da checagem de vínculo e papel (não vaza o estado do módulo a quem não pode operar) e antes de qualquer trava ou gravação. Desligado: nada é gravado, nem réplicas idempotentes; ao religar, a réplica volta a funcionar sem duplicar.
Corpo de cada RPC = o vigente + 2 linhas (comentário e chamada). Assinatura, ACL, papéis (estorno só owner/admin), idempotência, ordem de travas e auditoria inalterados.

## Rollback
- **E9.1A:** restaura o corpo exato das 4 RPCs e remove a função da chave. Não mexe em concessões nem em dados.
- **E9.1 (ajustado):** não apaga mais concessões em cascata: PARA, sem alterar nada, se existir qualquer concessão por empresa (informa quantas) ou se a E9.1A ainda estiver aplicada. Para reverter, remova as concessões de propósito e reverta a E9.1A antes.
