# Ciclo de vida dos tokens do Embedded Signup (análise técnica — Etapa 7)

Somente análise. **Nada de renovação automática foi implementado** e nenhum endpoint de renovação foi inventado.
Referências oficiais consultadas em 2026-10-29: *Access Tokens Guide* (WhatsApp), *Onboarding business customers as a Solution Partner*,
*Facebook Login for Business* (Business Integration System User tokens) e *Install Apps, Generate, Refresh, and Revoke Tokens* (system users).

## 1. O que a Meta documenta (e o que NÃO documenta)
| Tema | Documentado | Não documentado |
|---|---|---|
| Troca do code | `GET /oauth/access_token` (`client_id`, `client_secret`, `code`) → `access_token`, `token_type`, `expires_in` **se o token expira** | duração fixa do token do Embedded Signup |
| Duração do BISU token (Business Integration System User) | padrão **nunca expira**; `set_token_expires_in_60_days=true` gera token que expira em 60 dias; existe um modelo de configuração "Embedded Signup com token de 60 dias" | qual das duas o NOSSO Configuration ID usa (precisa ser conferido no painel da Meta) |
| Renovar | para **system user tokens**: `GET /oauth/access_token` com `grant_type=fb_exchange_token` + `set_token_expires_in_60_days=true` renova por mais 60 dias; o antigo vale até o próprio vencimento e depois é revogado (`/oauth/revoke`) | que essa renovação **se aplique** ao token obtido pelo code do Embedded Signup. A página de system users não menciona Embedded Signup/Login for Business, e a de Login for Business não descreve renovação ("reautenticação futura"). **Não implementar sem confirmar na Meta** |
| Revogação pelo cliente | o cliente remove o app em *Business Settings → Integrations → Connected apps* | evento de webhook correspondente (não há `account_update`/`partner_removed` descrito nas páginas consultadas) |
| Verificar validade | — | `debug_token` não aparece nessas páginas para este tipo de token |

## 2. Como o sistema trata hoje
- **Conhecer a expiração:** `whatsapp-signup-complete` guarda `expires_in` (quando a Meta o devolve) em `company_whatsapp_connections.token_expires_at` e marca `token_status='valid'`.
  Se a Meta **não** devolver `expires_in`, `token_expires_at` fica nulo (token tratado como sem prazo). Nenhuma rotina lê esses campos depois.
- **Detectar token inválido:** só no envio. `_shared/whatsapp-dispatch.ts` classifica HTTP 401 / código Graph `190` como `graph_auth` e mostra
  "A conexão do WhatsApp precisa ser reconectada. Procure o administrador." A mensagem fica `failed`, **mas a conexão continua `active` e `token_status='valid'`**
  (a RPC `whatsapp_connection_set_health` existe e **não é chamada por ninguém**).
- **Evitar envio com token revogado:** hoje **não evita**; cada envio tenta e falha (a Graph recusa; nenhuma mensagem sai). `whatsapp_get_send_context` não
  consulta `token_expires_at` nem `token_status`. Também o envio automático da IA e as notificações de pedido usam o mesmo contexto, então falham em silêncio para o cliente final.
- **Alertar empresa/administrador:** não existe alerta proativo. O owner só descobre ao tentar enviar. O Admin Master não tem visão de saúde das conexões.
- **Recebimento:** o webhook de mensagens não depende do token do cliente (a assinatura é do app); só trata `field = messages`. Eventos de conta (revogação/remoção do parceiro)
  são ignorados.

## 3. Procedimento efetivamente suportado hoje
**Reconexão pelo próprio Embedded Signup.** `whatsapp_signup_complete` já reconecta o mesmo número na mesma empresa, reaproveitando a linha, rotacionando o token
(o segredo antigo é apagado só se nenhuma conexão o referencia), e pulando o registro se o número já foi registrado por nós. É o único caminho de "renovação" que
temos como suportado e testado. Pré-requisito do piloto: a empresa precisa estar na allowlist e a conexão antiga deve estar desconectada (limite de uma conexão ativa por empresa).

## 4. Lacunas e propostas (para decidir — nada disso foi implementado)
1. **Descobrir qual duração o Configuration ID `1293818852874387` gera** (conferir no painel da Meta se o modelo é o de "60 dias"). É a decisão que define se a lacuna é urgente.
2. **Registrar a saúde no envio:** quando `graph_auth` ocorrer, chamar `whatsapp_connection_set_health(conn, 'error', 'graph_auth')` (a RPC já existe, só `service_role`), sem desligar o recebimento. Barato e sem endpoint novo.
3. **Pré-checagem no envio:** `whatsapp_get_send_context` recusar com mensagem amigável quando `token_expires_at <= now()`, evitando chamadas inúteis e o falso "enviado".
4. **Aviso antecipado:** rotina diária (cron) marcando `token_status='expiring'` quando faltarem ≤ 10 dias; banner para owner/admin em Configurações → WhatsApp e coluna de saúde para o Admin Master.
5. **Eventos de conta:** avaliar assinar/tratar os campos de conta do webhook **somente se** a Meta os documentar para este fluxo (hoje não confirmado).
6. **Renovação automática por `fb_exchange_token`:** **só após confirmação oficial** (ou teste controlado no piloto, com número de teste) de que se aplica ao token do Embedded Signup. Se confirmada, exigir:
   guardar o novo token no Vault antes de revogar o antigo, nunca logar token/`appsecret_proof`, e falha fechada. Até lá o caminho é a reconexão (item 3).
7. **Pergunta aberta para a Meta/suporte:** o token do code com `expires_in` ausente é realmente sem prazo? Existe webhook de revogação pelo cliente para parceiros Tech Provider?

## 4b. PENDÊNCIAS OBRIGATÓRIAS antes da liberação comercial (registradas na Etapa 7.1)
Sem estas quatro, o Embedded Signup **não deve ser aberto a clientes pagantes** (o piloto controlado, com acompanhamento, pode seguir):
1. **Identificar tokens expirados ou revogados** (marcar `token_status`/`last_error_code` ao detectar 401/190 no envio, rotina de expiração a partir de `token_expires_at`).
2. **Bloquear com segurança o envio com credencial inválida** (recusar antes de chamar a Graph e nunca mostrar "enviado"; mensagem amigável; sem desligar o recebimento).
3. **Avisar a empresa e a administração** (banner para owner/admin em Configurações → WhatsApp; visão de saúde das conexões para o Admin Master).
4. **Procedimento de reconexão** documentado e testado (hoje: desconectar e refazer o Embedded Signup; a renovação automática por `fb_exchange_token` só depois de confirmada
   para tokens do Embedded Signup).

## 5. Risco atual (resumo)
Se um token expirar ou for revogado, o atendimento **recebe** mensagens normalmente, mas o **envio falha** e a conexão continua aparecendo como ativa/válida. Para o piloto
(poucas empresas, acompanhadas) o risco é aceitável; antes de abrir para mais empresas, implementar ao menos os itens 2, 3 e o banner do item 4.
