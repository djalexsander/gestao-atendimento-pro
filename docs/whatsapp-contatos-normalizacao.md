# Contatos do WhatsApp — normalização de telefone e regras de unificação (Etapa 7.2, local)

Migration: `supabase/migrations/20261126010000_whatsapp_contacts_search.sql` (somente funções; **não aplicada no remoto**).
Testes: `.claude/db-tests/whatsapp-contacts.mjs`.

## 1. Auditoria da normalização existente

| Função | Regra | Problema para agrupar pessoas |
|---|---|---|
| `whatsapp_phone_core(texto)` | tira não-dígitos; se tem 12/13 dígitos e começa com 55, remove o 55; se sobram 11 dígitos e o 3º é `9`, remove esse `9` | **Agrupa indevidamente**: remove o 9 de qualquer `DD 9 xxxxxxxx`, sem olhar o dígito seguinte. Celulares de faixa nova (`9` + `1..5`) nunca existiram com 8 dígitos, então `11 9 5123-4567` vira `1151234567`, igual ao **fixo** `11 5123-4567`. Também trata qualquer número de 11 dígitos como brasileiro (um número de outro país pode colidir). |
| `whatsapp_br_phone_equivalent(a, b)` | só equivale se um tem `55DD9[6-9]xxxxxxx` e o outro `55DD[6-9]xxxxxxx` | Correta (é a regra do envio em modo teste). |

`whatsapp_phone_core` serve às **sugestões** de vínculo (até 5, o operador confirma). Para **unificar contatos** isso não basta, porque agruparia pessoas diferentes sem aviso. A unificação usa uma chave nova com a mesma regra da equivalência.

## 2. Chave de contato (`whatsapp_contact_key`)

- Só dígitos. Telefone de **conversa** vem em E.164 (com código do país) e nunca recebe prefixo.
- `55 DD 9 [6-9]xxxxxxx` → `55 DD [6-9]xxxxxxx` (o 9 só é removido quando o dígito seguinte é 6..9).
- Telefone de **cliente** e texto **digitado na busca** (`p_br_local = true`): 10 ou 11 dígitos são tratados como DDD + número do Brasil (`55` é prefixado) e depois aplicam a regra acima.
- Números de outros países ficam como estão. Números locais de 8/9 dígitos (sem DDD) ficam como estão e só casam por finais.
- Limitação conhecida: número local sem DDD digitado no cadastro do cliente não se junta a conversas.

## 3. Unificação (uma linha por empresa + chave)

Fontes (nada é copiado): conversas **não excluídas** e clientes **ativos** da empresa.
- Várias conversas da mesma chave (conexões diferentes, com/sem o 9) = 1 contato; abre a conversa mais recente (`last_message_at`, depois `created_at`, `id`).
- Nome: **cliente ativo** > **nome do perfil** (mais recente não vazio) > **telefone**.
- Cliente: o **vinculado** à conversa (se ativo) vale mesmo sem coincidir o telefone; senão, o ativo cujo `whatsapp`/`phone` tem a mesma chave. Se vários coincidem, escolhe-se por (nome, id) e `customer_matches` informa a ambiguidade.
- Cliente ativo sem conversa vira contato (chave do `whatsapp`, senão do `phone`), sem conversa para abrir. Se já está representado por alguma conversa, não duplica.
- Cliente **inativo**: nunca empresta nome nem vira contato. Conversa **excluída**: nunca aparece nem empresta o nome do perfil.

## 4. Busca

- Nome: sem acento e sem diferenciar caixa (tabela fixa de acentos, sem a extensão `unaccent`); até 6 termos, todos obrigatórios; `%` e `_` são texto. Pesquisa o nome do cliente e o do perfil.
- Só dígitos/máscara: 2 dígitos = DDD; 3 a 9 dígitos = finais (9 dígitos com `9` inicial seguido de 6..9 perdem o 9); 10 a 13 dígitos = número completo (com/sem 55, com/sem o nono dígito). 1 dígito ou mais de 13 = resultado vazio.
- Paginação por cursor (`sort`, `key`) com ordem total `(sort_name, contact_key)`; limite 1..100 (padrão 30).

## 5. Riscos conhecidos

- Consulta calculada na hora (sem tabela): custo cresce com conversas + clientes da empresa; o teste de volume (9000 origens) mede o tempo. Acima de dezenas de milhares por empresa, materializar (tabela `whatsapp_contacts`, etapa futura).
- Nomes em Unicode decomposto (NFD) não são dobrados.
- Dois clientes diferentes com o mesmo número viram um contato (com `customer_matches` > 1).
