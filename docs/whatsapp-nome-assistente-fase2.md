# WhatsApp — Nome personalizado da assistente virtual (Fase 2)

Status: **implementado LOCALMENTE**. Migration NÃO aplicada no remoto, Edge Function NÃO publicada, nenhum nome configurado.

## O que faz
Cada empresa pode escolher o nome da assistente (ex.: Juliana). Na **primeira saída da conversa** o AUTO prefixa uma apresentação fixa:

- com nome: `Olá! Eu sou a Juliana, assistente virtual da Djalexeventos.`
- sem nome: `Olá! Sou a Assistente Virtual da Djalexeventos.`

Sempre diz que é assistente virtual. Conversa nova (inclusive após soft delete) apresenta de novo; nunca reapresenta na mesma conversa.

## Regras
- **Primeira saída** = a conversa não tem nenhuma mensagem outbound que não tenha falhado (humana, IA ou aviso do pedido). Mensagem que
  falhou não conta (o cliente nunca a recebeu). human → inherit, retry, novo pedido, handoff etc. não reapresentam.
- **Só saudação** ("Oi", "Bom dia", "Boa tarde, tudo bem?"): resposta 100% template `apresentação + " Como posso ajudar?"`, **sem OpenAI** e sem cota.
- **Pergunta ou pedido na 1ª mensagem**: a apresentação vira prefixo (`apresentação\n\nresposta`); a resposta vem do fluxo normal
  (conhecimento, pedido, templates). Uma saudação inicial da própria resposta ("Olá!") é removida para não duplicar.
- **O nome NUNCA entra em prompt** (nenhum construtor de prompt o conhece). A frase é montada no banco e prefixada na Edge **depois**
  das checagens de segurança da resposta. Nome com cara de instrução (ignore/prompt/sistema/regra/openai…) é recusado.
- Suggest, fluxo humano e avisos operacionais do pedido (Bloco A) **não** usam o nome.

## Banco (migration `20261023010000_whatsapp_ai_display_name.sql`, aditiva)
- `company_whatsapp_ai_settings.ai_display_name` (nullable). Validação única `whatsapp_ai_display_name_valid`: 1–40 caracteres, sem
  espaços nas pontas/duplos, uma linha, letras/números/espaço/`.`/`'`/`-`, até 4 palavras, sem termos de instrução.
- `whatsapp_ai_set_display_name(company, name)`: só **owner/admin**; vazio/espaços → `null`; newline/tab rejeitados (nunca "normalizados").
- `whatsapp_ai_get_settings` devolve `ai_display_name` para owner/admin (aditivo; `update_settings` inalterada e não apaga o nome).
- `whatsapp_ai_auto_intro(job)`: só `service_role`; devolve `{first, intro}`.

## Edge / UI
- `_shared/ai-intro.ts` (puro, sem imports): `isGreetingOnly`, `greetingReply`, `composeWithIntro`.
- `whatsapp-ai-auto/handler.ts`: chama `whatsapp_ai_auto_intro` por job (falha/migration ausente = comportamento anterior); contexto **por job**
  (o `Ctx` base é compartilhado entre jobs concorrentes); aplicação central em `commitAndDispatch`.
- Tela de configuração da IA: campo "Nome da assistente" (placeholder `Juliana`, texto auxiliar) + prévia dinâmica; grava pela RPC própria
  só quando o nome mudou.

## Efeito para empresas já em AUTO
Mesmo **sem** nome configurado, a primeira resposta de uma conversa nova passa a vir com `Olá! Sou a Assistente Virtual da <empresa>.`
(regra pedida). Conversas já em andamento não mudam.

## Para ligar (SOMENTE com autorização)
`db push` da migration → deploy de `whatsapp-ai-auto` → configurar o nome na Djalexeventos pela tela (ou RPC).
