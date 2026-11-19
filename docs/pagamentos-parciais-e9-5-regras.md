# E9.5 — Editor de divisão da conta (local; nada no remoto)

Código: `splitEditorLogic.ts` (puro), `splitEditorController.ts`, `SplitEditor.tsx`, montado dentro do diálogo financeiro (E9.4) da conta aberta. Testes: `split-editor-logic.mjs` (35), `split-editor-contract.mjs` (33, RPCs reais), `split-editor-static.mjs` (14), mutação de 36 casos.

## Regras do servidor refletidas na tela
- A divisão sempre cobre o **saldo pendente**, com 2 a 50 partes; pagamentos e alocações já feitos **nunca são alterados**; a divisão anterior fica no **histórico de versões** (`get_session_split_history`). A versão é otimista (`p_expected_version`; sem divisão = 0).
- Modos: **iguais** (saldo ÷ n por piso; os centavos que sobram vão +1 para as primeiras partes), **por valores** (soma = saldo pendente; mostra falta/excede) e **por produtos** (unidades de partes já quitadas ficam travadas; só quando o valor das unidades disponíveis é igual ao saldo; cada unidade tem dono; parte sem item não vale).
- Rótulos: até 40 caracteres, sem repetição (sem diferenciar maiúsculas).

## Refazer sem redistribuição silenciosa
- `replaceImpact` explica o efeito: a versão atual fica no histórico; a nova cobre só o pendente; partes quitadas ficam na versão antiga; parcialmente pagas voltam pelo que falta.
- Com valor já pago na divisão atual, salvar exige **confirmação explícita**; sem valor pago não exige.
- Por pessoa (rótulo) o histórico soma pago e pendente ao longo das versões.

## Controlador
- Mesmas regras da E9.4: id estável por tentativa (mesmos dados e versão = mesmo id), **resultado desconhecido** trava e só reenvia o mesmo pedido, **versão desatualizada** (PT409) recarrega histórico e saldo, trava de clique duplo, uma pendência bloqueia outra divisão.
- Valida nomes, soma e limites antes de enviar; sem saldo pendente não divide. Depois de salvar, o diálogo adota o estado devolvido pela RPC.
- Fica desabilitado enquanto há pagamento/estorno em andamento ou resultado desconhecido no diálogo.
