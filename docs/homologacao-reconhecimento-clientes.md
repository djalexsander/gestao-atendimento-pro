# Homologação controlada — reconhecimento de clientes, endereços e saudação (WhatsApp IA)

Estado: **tudo local**. Nada foi aplicado no Supabase remoto, nenhuma Edge Function foi publicada, nada foi commitado.

## 1. O que existe (e em que ordem aplicar)

| # | Arquivo | O que faz |
|---|---|---|
| 1 | `supabase/migrations/20261112010000_whatsapp_customer_auto_link.sql` | vínculo automático (ingestão), endereço salvo no rascunho (offer/accept/use), saudação personalizada, **flag por empresa** (`company_whatsapp_ai_settings.customer_recognition_enabled`, padrão `false`), RPCs do Admin Master, trilha de auditoria |
| 2 | `supabase/migrations/20261113010000_customer_address_primary_kind.sql` | tipo (Casa/Trabalho/Outro), endereço principal, anti-duplicidade, `whatsapp_saved_address_pick` (principal primeiro) |
| 3 | Edge Function `whatsapp-ai-auto` (+ `_shared/ai-intro.ts`, `ai-order.ts`, `ai-order-flow.ts`) | saudação, pergunta/confirmação do endereço |
| 4 | Frontend web/desktop (`CustomerAddressesSection`, `DeliveryNewOrder`, …) | tela Clientes e novo pedido de Delivery |

Ordem obrigatória: **1 → 2 → 3 → 4**. O `supabase db push` já aplica 1 e 2 na ordem do nome do arquivo, cada uma numa transação (se uma falhar, nada dela fica pela metade).

### Dependências e funções existentes que são alteradas

A migration 1 troca, por substituição EXATA da definição viva (mesmo método da 20261103010000), estas funções: `whatsapp_ingest_message`, `link_whatsapp_conversation_customer`, `whatsapp_order_state` — e redefine `whatsapp_ai_auto_intro`. **Se a definição no remoto diferir da dos arquivos locais (hotfix manual), a migration falha inteira e não aplica nada.** Antes do push: comparar `pg_get_functiondef` dessas 4 funções no remoto com a do repositório.

A migration 2 remove as assinaturas de 12 argumentos de `create_customer_address` / `update_customer_address` (substituídas pelas de 13, com `p_kind` opcional) e redefine `list_customer_addresses`, `set_customer_address_active` e `whatsapp_saved_address_pick`.

Bloqueios: colunas novas com valor padrão constante (rápido, só metadados); as constraints de tipo de evento são recriadas (varredura curta) em `whatsapp_conversation_events` e `whatsapp_order_draft_events`. Aplicar fora do horário de pico.

## 2. Sem perda de dados (provado)

`.claude/db-tests/customer-recognition-upgrade.mjs` (38 checks): banco no estado atual do remoto + dados realistas (inclusive **endereços duplicados legados**, conversas vinculadas por humano, pedido de delivery com endereço), aplica 1 e 2 e prova:
- clientes, endereços (colunas antigas), conversas, mensagens, rascunhos, pedidos, atendimentos, configurações e eventos: conteúdo idêntico;
- endereços existentes ficam `kind='other'`, `is_primary=false`; o par de duplicados legados continua ativo e intacto (a regra nova só vale daqui para frente);
- vínculos já existentes viram `customer_link_source='manual'`; nada é vinculado pela migration;
- flag **desligada** em todas as empresas; nenhum evento gerado;
- `whatsapp_ai_auto_intro` devolve **exatamente o mesmo JSON** de antes; a ingestão não vincula nada;
- front antigo (10 argumentos posicionais / por nome, sem `p_kind`) continua criando/listando/editando endereços;
- dono da empresa NÃO consegue ligar a flag; outra empresa não enxerga nada.

## 3. Ativação controlada (flag por empresa)

`customer_recognition_enabled` nasce **false para todas as empresas** (inclusive a Djalexeventos). Desligada, o atendimento é o de antes: sem vínculo automático, saudação antiga ("Olá! Sou a Assistente Virtual…"), sem oferta de endereço. Só o Admin Master liga/desliga, na hora, **sem deploy**, com auditoria (`whatsapp_feature_events`):

```sql
-- ligar para a ALEXPROAPPS (somente quando a conexão pela Meta estiver disponível)
select public.master_whatsapp_set_customer_recognition('<company_id da ALEXPROAPPS>', true, 'homologação');
-- desligar (mantém os vínculos); ou desligar desfazendo só os vínculos AUTOMÁTICOS e zerando ofertas abertas:
select public.master_whatsapp_set_customer_recognition('<company_id>', false, 'fim do teste', true);
-- ver quem está ligado
select * from public.master_whatsapp_customer_recognition_list();
```

Exige a configuração da IA da empresa (a flag mora nela). O cadastro de endereços (tela Clientes/Delivery) **não** depende da flag: ela governa só o WhatsApp.

Compatibilidade provada: Edge nova + banco antigo (`whatsapp-customer-flow-compat-e2e.mjs`, 9 checks) e as suítes antigas do WhatsApp rodam com as expectativas ORIGINAIS (flag desligada).

## 4. Rollback

Arquivos (fora de `supabase/migrations`, aplicar manualmente, **nesta ordem**): `.claude/db-tests/whatsapp-customer-address-primary.rollback.sql` (desfaz a 2) e depois `.claude/db-tests/whatsapp-customer-auto-link.rollback.sql` (desfaz a 1). Testados em `customer-recognition-upgrade.mjs` e `whatsapp-signup-foundation.mjs` (schema volta ao baseline; `intro` volta ao JSON original).

Limitações (documentadas, esperadas):
1. Tipo e endereço principal escolhidos depois da migration são **perdidos** (as colunas deixam de existir). Endereços e clientes não são apagados.
2. A trilha `whatsapp_feature_events` e os eventos de tipo novo (`customer_match_ambiguous`, `saved_address_*`, `customer_synced`) são apagados no rollback — exporte antes se quiser guardar.
3. Vínculos automáticos já gravados em `whatsapp_conversations.customer_id` permanecem (só a coluna de origem some). Para desfazê-los antes do rollback: desligar a flag com `p_clear_auto_links = true`.
4. Rollback não é transacional entre as duas migrations (rodar 2 e depois 1) e nunca foi executado no remoto.
5. Rollback do front/Edge: republicar a versão anterior. Com a migration aplicada e a flag desligada, a Edge antiga e o front antigo continuam funcionando.

## 5. Transição entre versões

| Combinação | Resultado |
|---|---|
| Migrations novas + front antigo + Edge antiga | funciona (RPCs aceitam as chamadas antigas) |
| Migrations novas + Edge nova + flag desligada | atendimento idêntico ao antigo |
| Edge nova + banco antigo | funciona (cai no comportamento anterior) |
| Front novo + banco antigo | **evitar**: editar endereço e "definir principal" falham até a migration 2 (criar endereço sem tipo ainda funciona) |

## 6. Estratégia de homologação (ALEXPROAPPS primeiro)

1. Backup/snapshot do banco; conferir as 4 definições de função do item 1; confirmar que a Djalexeventos **não** tem a flag (nasce `false`).
2. Aplicar as migrations 1 e 2 (`supabase db push`). Verificar: flag `false` em todas as empresas, nenhuma conversa nova vinculada, atendimento da Djalexeventos inalterado (mensagem de teste pelo fluxo normal).
3. Publicar a Edge `whatsapp-ai-auto`. Repetir a verificação da Djalexeventos (saudação antiga, pedido normal).
4. Publicar o frontend (web e desktop); conferir Clientes e novo pedido.
5. **Só com a conexão Meta da ALEXPROAPPS disponível**: `master_whatsapp_set_customer_recognition(<ALEXPROAPPS>, true)` e testar com número real: cliente com endereço principal; sem endereço; dois cadastros com o mesmo telefone; recusar o endereço; endereço fora da zona; transferência para humano; conferir os eventos de auditoria.
6. Observar; se algo sair do esperado, desligar a flag (efeito imediato, sem deploy). Só depois decidir ampliar para outras empresas, uma a uma.
