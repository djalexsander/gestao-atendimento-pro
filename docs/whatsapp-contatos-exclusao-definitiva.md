# Contatos manuais do WhatsApp — especificação da exclusão definitiva

Status: **implementada localmente na Etapa 7.10I** (migration `20261130010000_whatsapp_contacts_delete.sql`, RPC `delete_whatsapp_contact`; ainda NÃO aplicada no remoto nem publicada). Decisão da implementação: a confirmação é a palavra exata `EXCLUIR` (conferida no banco), em vez do telefone.

## Princípio

Arquivar (já existe) é o caminho normal e reversível. Exclusão definitiva é exceção: apaga o contato e as observações **sem volta**, e existe para atender pedido de remoção de dados (LGPD) ou limpeza de cadastro errado.

## Quem pode

- **Somente o dono** (`owner`) da empresa. Administrador, atendente e caixa não excluem.
- Sessão válida, empresa do usuário, módulo WhatsApp contratado e empresa **não** em modo somente leitura (PT402) — mesmas barreiras das demais RPCs.

## Pré-condições

1. O contato precisa estar **arquivado** antes (dois passos deliberados: arquivar e depois excluir).
2. Contato inexistente ou de outra empresa: mesma resposta PT404 (nada de outra empresa é revelado).
3. Se houver cliente vinculado, o vínculo não impede a exclusão (o contato é que some; o cliente permanece intacto). Nenhuma conversa, mensagem ou cliente é alterado ou apagado.

## Confirmação explícita

RPC `delete_whatsapp_contact(p_contact_id uuid, p_confirmation text)`:

- `p_confirmation` deve ser exatamente `EXCLUIR` (maiúsculas, sem espaços), conferido no banco, não só na tela. (Decisão 7.10I: mais simples no celular que digitar o telefone e não expõe o número em um campo de texto.)
- A interface exibirá o aviso: "Esta ação apaga o contato e suas observações definitivamente e não pode ser desfeita."
- Sem confirmação correta: PT400, nada é alterado.

## Proteção de dados

- A linha de `whatsapp_contacts` é removida (`DELETE`), incluindo nome, telefone e observações. Nenhuma cópia fica em outra tabela.
- O trigger de imutabilidade e o guarda de escrita já cobrem o DELETE; o DELETE só é feito dentro da RPC (sem grant direto).
- Eventos de auditoria **não** guardam nome, telefone nem observações, então não precisam ser apagados e continuam sem dado pessoal. Os eventos anteriores desse contato permanecem (a tabela de eventos não tem FK para o contato de propósito).
- Backups do provedor seguem a política de retenção dele; o texto da tela e a política de privacidade devem informar isso.

## Auditoria

Um evento `deleted` em `whatsapp_contact_events`: `contact_id`, `company_id`, `actor_user_id = auth.uid()`, `created_at`, e `old_value = {"campos": ["nome","telefone","observacoes"?], "tinha_cliente": bool}` — apenas metadados, nunca o conteúdo. Evento e DELETE na mesma transação (ou os dois ou nenhum).

## Concorrência e integridade

- `SELECT ... FOR UPDATE` no contato antes de apagar; exclusão repetida devolve PT404 (já não existe).
- Não toca em `customers`, conversas, mensagens, IA, Coexistence ou conexões.
- Nunca em lote nesta primeira versão: um contato por chamada.

## Testes exigidos na etapa

Papéis (só owner), contato ativo recusado, confirmação errada/ausente, outra empresa, PT402, evento sem dado pessoal, linha realmente removida, evento preservado, cliente e conversas intactos, concorrência (duas exclusões), rollback.

## Fora de escopo agora

Interface, exclusão em lote, exclusão automática por prazo, anonimização em vez de remoção.
