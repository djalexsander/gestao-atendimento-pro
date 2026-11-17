# Iniciar conversa pelo WhatsApp — Etapa 7.11G (interface, local)

Somente frontend + testes. **Nada aplicado, publicado, ativado, enviado ou commitado.** Nenhuma mensagem real; nenhuma migration no remoto; nenhuma configuração da Meta alterada.

## O que a tela faz (`/operacional/whatsapp/contatos`)
- **Iniciar conversa** em cada contato/cliente **sem conversa** (contato manual ativo ou cliente confiável). Não aparece: com conversa (continua "Abrir conversa"), arquivado, cliente ambíguo (vários clientes com o número), papel sem permissão, recurso não habilitado pelo Master (`whatsapp_get_start_settings.enabled/can_start`) ou falha ao consultar a configuração (recurso escondido).
- Diálogo: contato, **aviso de cobrança da Meta**, uso do dia/limite/intervalo, verificação do **bloqueio (opt-out)**, seleção só de templates **aprovados e elegíveis** (os inelegíveis são contados à parte, nunca selecionáveis), campos das variáveis com **prévia** da mensagem, **consentimento** (confirmação + origem + referência 3–80 car., sem telefone/8+ dígitos).
- Envio **uma vez por clique** (trava no diálogo e no controlador). O corpo da Edge leva só ids + variáveis + consentimento: **nenhum telefone, token, nome ou texto**.
- Resultado: `accepted` → abre `?conversation=<id>` ("aceita pela Meta", nunca "entregue"; a entrega só aparece nas solicitações quando a Meta avisa); `unconfirmed`/`in_progress` → painel com Abrir conversa e Ver solicitações (nada é reenviado); `failed` → mensagem do servidor (PT402 incluído); falha de rede → incerto, **mesmo `client_request_id`** mantido (repetir é seguro); recusa definitiva → novo id na próxima tentativa.
- **Solicitações** (botão no cabeçalho, com contagem das que precisam de ação): lista `whatsapp_list_start_requests`; incerto → "Conferi: enviada / NÃO enviada"; aguardando envio → "Cancelar"; exige marcar a atestação; **não existe reenvio**.

## Arquivos
Novos (`apps/web/src/features/whatsapp/`): `whatsappStartLogic.ts` (lógica pura), `whatsappStartApi.ts` (RPCs + Edge + controlador), `WhatsappStartUi.tsx` (diálogo, resultado, solicitações).
Alterados: `WhatsappContacts.tsx` (ligação, `useNavigate` só para abrir a conversa criada), `WhatsappContactsView.tsx` (botão/Solicitações), `index.css` (bloco `sc-*` responsivo).
Testes (`.claude/`): `frontend-tests/whatsapp-start-ui.mjs` (109 checks), `frontend-tests/_mutate-start-ui.mjs` (29 mutantes), preview fictício `whatsapp-preview/start.{html,tsx}`; ajustes em `whatsapp-contacts-ui.mjs` (emits novos) e `whatsapp-manual-contacts-ui.mjs` (6.8: a única navegação do contêiner é a do Iniciar conversa).
7.11E/F: +checks `58b/58c` (E), `13b/49b/49c` (F), mutantes combinados e lista de equivalentes justificados nos dois `mutate-*.mjs`.

## Riscos e pendências (bloqueantes para ativar)
1. **BLOQUEANTE para a ativação live — eco da Coexistence**: `whatsapp_ingest_echo` não usa o lock de conversa nem a equivalência do nono dígito ao CRIAR conversa. Eco concorrente com o início, em forma de telefone diferente (com/sem 9), pode criar **duas conversas do mesmo contato**. Não corrigido (exige autorização específica para mexer no webhook/eco).
2. Aplicar na ordem: `20261201010000` → `20261202010000` → `20261203010000` → `20261203020000` → `20261204010000` → `20261205010000`; depois deploy manual de `whatsapp-templates-sync` e `whatsapp-start-conversation`; só então publicar o frontend. Habilitação por empresa apenas pelo Master.
3. Reconciliação automática de resultados incertos não existe (só o operador resolve); `confirmed_sent` grava id sintético (`manual:<mensagem>`), sem correlação com status posteriores da Meta.
4. Homologação com a **Meta real** (template aprovado, número de teste/autorizado, cobrança) não foi feita — proibida nesta etapa.
5. Mutantes sobreviventes são equivalentes justificados (defesa em profundidade; só divergem sob concorrência real, que o PGlite de 1 conexão não reproduz).
