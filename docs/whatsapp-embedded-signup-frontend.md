# WhatsApp Embedded Signup v4 — frontend (Etapa 5)

Tela: `/app/configuracoes/whatsapp` (`WhatsappConnection.tsx`). Botão **Conectar meu WhatsApp** em `WhatsappSignupPanel.tsx`.
Nada disto liga o recurso em produção: o botão só funciona quando o operador ativar `whatsapp_platform_settings.embedded_signup_enabled`.

## Quem vê o botão
| Situação | Resultado |
|---|---|
| owner/admin + módulo WhatsApp + sem conexão ativa + plataforma liberada | botão habilitado |
| idem, mas `embedded_signup_enabled = false` | botão **desabilitado** + explicação amigável |
| App Desktop (Tauri) | desabilitado, orienta a usar o navegador (a janela da Meta não é suportada) |
| empresa já com conexão ativa | botão **oculto** (mensagem "desconecte para trocar de número") |
| atendente/caixa ou módulo não contratado | oculto (o servidor também recusa) |

## Fluxo (duas etapas, de propósito)
1. **Clique 1 — "Conectar meu WhatsApp":** `whatsapp_signup_begin` cria a sessão (state de 64 hex, App ID, Config ID — nada fixo no código) e o SDK
   é carregado. O SDK **só** é carregado nesse momento.
2. **Clique 2 — "Continuar com a Meta":** `FB.login` é chamado **sincronamente** dentro do clique (senão o navegador bloqueia o pop-up).
   Parâmetros da documentação oficial: `config_id`, `response_type: 'code'`, `override_default_response_type: true`, `extras: { setup: {} }`.
3. O `postMessage` da Meta (`WA_EMBEDDED_SIGNUP`) só vale se a origem for `https://facebook.com` ou subdomínio (comparação estrita; `evilfacebook.com`
   não passa). `FINISH` + authorization code → envio **imediato** para a Edge `whatsapp-signup-complete` com
   `{ state, code, waba_id, phone_number_id, pin? }`. Os IDs do navegador são só dicas: o backend confirma na Meta com o token do cliente.
4. `CANCEL`/`ERROR`/janela fechada/pop-up bloqueado/SDK bloqueado → mensagens amigáveis; nenhuma chamada ao backend.

## PIN (verificação em duas etapas)
O authorization code é de **uso único e dura ~30 s**, e o servidor encerra a sessão quando responde `pin_required`. Portanto o único caminho
funcional é: mostrar o formulário do PIN → criar uma **sessão NOVA** → abrir um **novo** cadastro na Meta (novo code) → enviar o PIN junto
(campo opcional `pin` do corpo, validado `^\d{6}$`). Cada envio é uma ação do usuário (máx. 3 por tela). O PIN fica só em memória e é apagado
no envio; nunca em localStorage/sessionStorage/URL/log. Mensagens específicas: PIN incorreto, registro bloqueado (133016/133008), resultado
incerto (sem retentativa; contate o suporte), número em outra empresa, empresa já conectada.

## CSP
O projeto **não tem Content-Security-Policy** hoje (nem em `vercel.json` nem em `index.html`), então nada bloqueia o SDK e **nenhum header foi
adicionado ou enfraquecido**. A Meta não publica, nas páginas oficiais consultadas, a lista de domínios para CSP. Confirmado:
`script-src https://connect.facebook.net` (SDK) e o pop-up/mensagens de `https://www.facebook.com` / `https://web.facebook.com`.
Se uma CSP for adotada no futuro: começar em `Content-Security-Policy-Report-Only`, liberar apenas esses domínios e validar o fluxo real
antes de impor (ver também `connect-src` para o que o SDK pedir).

## Configuração exigida no app da Meta (documentação oficial)
Facebook Login for Business → Settings → Client OAuth settings: *Client OAuth login*, *Web OAuth login*, *Enforce HTTPS*,
*Embedded Browser OAuth Login*, *Use Strict Mode for redirect URIs*, *Login with the JavaScript SDK* = Sim; domínio do app em
*Allowed domains* e *Valid OAuth redirect URIs* (só HTTPS). Sem isso o FINISH não é devolvido.

## Decisões a registrar
- `FB.init` com `autoLogAppEvents: false` e `xfbml: false` (a documentação mostra `true`/`true` no exemplo, mas não são exigidos): evita
  enviar eventos do app à Meta e varrer a tela que tem o campo de PIN.
- `featureType` e `sessionInfoVersion` **não** foram usados: não constam na documentação v4 consultada (Coexistence fica para depois).
- `FACEBOOK_SDK_VERSION = "v26.0"` (documentação vigente) fica em `whatsappSignupLogic.ts`.
