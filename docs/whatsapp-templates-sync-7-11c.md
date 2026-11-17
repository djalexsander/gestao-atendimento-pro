# Sincronização de templates da Meta e opt-out — Etapa 7.11C

Status: **implementado somente em ambiente local** (migration `20261202010000_whatsapp_templates_sync.sql`, Edge `whatsapp-templates-sync`). Nada aplicado, publicado ou chamado na Meta. Funcionalidade **desativada** para todas as empresas.

Decisões confirmadas da V1: ativação só pelo Master · owner/admin/attendant iniciam · 50 por dia por empresa · 24 h por contato · dia civil de Brasília (`America/Sao_Paulo`) · consentimento = confirmação do operador, **sem dispensar autorização real do destinatário** · desativada por padrão.

## 1. O que foi implementado

**Edge `whatsapp-templates-sync` (JWT; só LEITURA na Meta)** — `GET /{versão}/{waba_id}/message_templates?fields=id,name,language,category,status,components&limit=100`, paginado pelo cursor `after`.

| Tema | Como |
|---|---|
| Conexão certa | A WABA e o token vêm do **banco**, da conexão ativa **da empresa do pedido** (uma ativa por empresa). O corpo da requisição só traz `company_id`; nunca token, WABA ou telefone. |
| Token | Lido no Vault só por `whatsapp_templates_sync_context` (service_role), e só com o lease válido da execução. Vai no header `Authorization`, **nunca na URL**, e nunca é registrado nem devolvido. A URL `paging.next` da Meta carrega `access_token` na query: **não é seguida nem registrada**; o cursor é reconstruído por nós. |
| Permissões do pedido | owner/admin da empresa (módulo WhatsApp e funcionalidade **ativada**) ou administrador da plataforma (pode sincronizar mesmo desativada, para validar o escopo antes de ativar). Attendant/caixa/produção: 403. |
| Concorrência | Lease por conexão (uma sincronização por vez; caduca em 2 min), intervalo mínimo de 60 s, linha de estado por conexão. Segunda chamada simultânea recebe `202 running` e **não** chama a Meta. |
| Cache | `whatsapp_templates_sync_apply` faz upsert por (conexão, nome, idioma), idempotente e sem duplicar; empresa e conexão vêm do **estado**, nunca do conteúdo; entradas inválidas são ignoradas e contadas; variáveis do corpo calculadas. |
| Removidos | Só uma sincronização **bem-sucedida e COMPLETA** marca como `DELETED` o que a Meta deixou de devolver. Falha, resposta incompleta ou teto de 50 páginas **nunca** removem nada. Lista válida e vazia é um resultado real. |
| Status/categoria/componentes | Atualizados a cada sincronização (APPROVED → PAUSED/REJECTED/DISABLED, mudança de categoria etc.). Template que volta a aparecer é reativado. |
| Elegíveis | `whatsapp_list_start_templates` devolve **somente APPROVED**, com `eligible` e motivo. V1 elegível = corpo de texto com variáveis numeradas, rodapé, cabeçalho de **texto sem variável**, botões de resposta rápida. Inelegível por ora: cabeçalho de mídia/variável, botão de URL/telefone, carrossel/fluxo/oferta. |
| Erros da Meta | Classificados sem dado sensível: `token_invalid` (190; subcódigos 459/464 não revogam o token), `missing_permission` (10 e 200–299), `rate_limited` (4, 17, 32, 613, 80004, HTTP 429), `timeout`, `network`, `meta_unavailable` (5xx), `waba_not_found` (100/404), `invalid_response`, `meta_http_<status>`. Só o código vai ao estado; mensagem amigável ao usuário. Token revogado confirmado é registrado pela função de saúde já existente. |

Não envia mensagem, não cria conversa, não toca em webhook, IA, Coexistence, conexões nem na tela. O banco não faz HTTP.

## 2. Procedimento proposto — validar o escopo do token em modo somente leitura (NÃO executado)

O token só existe no Vault e só sai para a Edge, então a validação do escopo **não pode** ser feita lendo o token à mão (isso o exporia). O caminho seguro é a própria Edge, que faz **uma única leitura** (`GET message_templates`): se o token não tiver o escopo de gerenciamento da conta, a Meta devolve erro de permissão (10 ou 200–299) e isso fica registrado como `missing_permission`, sem expor nada.

Pré-requisitos (cada um exige autorização sua; hoje nada disto foi feito):
1. Aplicar a migration `20261201010000` (7.11B) e a `20261202010000` (7.11C) — aditivas, sem tocar nada existente.
2. Fazer o deploy **manual** da Edge `whatsapp-templates-sync` (`--use-api`, sem `--prune`, sem `--no-verify-jwt`), usando o secret `WHATSAPP_GRAPH_API_VERSION` que já existe.
3. Escolher a **conexão de teste** (`mode = test`, `cloud_api`), nunca a conexão live em Coexistence.

Execução (somente leitura na Meta): o administrador da plataforma (Master), logado, chama a Edge para a empresa da conexão de teste (a funcionalidade continua DESATIVADA; o Master pode sincronizar mesmo assim). Resultado esperado e como ler:
- `200 ok` → o token tem o escopo; a tabela de cache passa a ter os templates reais (somente leitura; nada na Meta mudou).
- `403 missing_permission` → falta o escopo `whatsapp_business_management`; é preciso reconectar a conta concedendo-o (nenhuma consulta a mais).
- `409 token_invalid` → token expirado/revogado; o fluxo de reconexão existente trata.
- Nenhum envio, nenhuma conversa, nenhuma escrita na Meta; o estado fica em `whatsapp_template_sync_state` (status e código do erro, sem token).
Conferir depois por SQL de leitura: estado da sincronização, contagem de templates por status e que nada mudou em conversas/mensagens/conexões.

## 3. Opt-out: como será respeitado e lacunas antes da ativação

**Situação auditada hoje**
- O recebimento (`whatsapp_ingest_message`) grava a mensagem e **não interpreta** pedidos como "PARAR", "SAIR" ou "CANCELAR".
- Não existe tabela nem estado de opt-in/opt-out por contato.
- A reserva do pedido de início (`whatsapp_start_request_reserve`, 7.11B) **não consulta** nenhum bloqueio por contato; só confere funcionalidade ativada, limites, intervalo e a confirmação do operador.
- O despacho não registra o sinal da Meta de que o usuário parou de receber (ex.: erro de "usuário optou por não receber"), nem bloqueia reenvios por causa dele.
- A confirmação do operador é uma **declaração**; ela não prova que o destinatário autorizou.

**Como será respeitado (desenho proposto)**
1. Tabela `whatsapp_contact_optouts` por empresa e **hash da chave do telefone** (mesma chave de equivalência do nono dígito), com origem (`inbound_keyword`, `operator`, `meta_signal`), data e quem registrou; sem texto da mensagem.
2. Gravação automática quando a mensagem **recebida** casar com palavras de saída (lista configurável, comparação sem acento/caixa, mensagem curta), idealmente respondendo uma confirmação padrão; gravação manual pelo operador; gravação ao receber da Meta o erro de opt-out.
3. A reserva do início passa a recusar (PT409) quem estiver em opt-out ativo, antes de consumir vaga; reativação só com novo consentimento registrado (quem, quando).
4. Opt-out vale também para outros envios de template da empresa, não só "iniciar conversa".

**Lacunas a resolver ANTES de ativar para qualquer empresa (bloqueantes)**
| # | Lacuna | Impacto |
|---|---|---|
| G1 | Não há estado de opt-out por contato | Contato que pediu para sair seria contatado de novo |
| G2 | O recebimento não detecta palavras de saída (exige mudar `whatsapp_ingest_message`, hoje fora do escopo autorizado) | G1 não se alimenta sozinho |
| G3 | A reserva não bloqueia opt-out | Idem |
| G4 | O despacho não trata o sinal de opt-out da Meta | Reincidência pode prejudicar a qualidade do número |
| G5 | Consentimento é só declaração do operador, sem prova nem origem | Risco regulatório (LGPD) e de reclamação à Meta |
| G6 | Sem política de retenção/relatório de opt-outs | Auditoria incompleta |

Recomendação: **não ativar** (nem na conexão de teste com destinatários reais) antes de G1–G4; G5 é mitigada na V1 por texto claro na confirmação e auditoria do operador, e deve evoluir para registro de origem do consentimento. G2 pode ser feito junto com o endurecimento do nono dígito no recebimento (etapa 7.11D), mediante autorização explícita para mexer nessa função.

## 4. Riscos desta etapa
- O escopo real do token ainda não foi comprovado (depende do procedimento da seção 2).
- Templates elegíveis na V1 são só os de texto simples; templates com mídia/botões dinâmicos ficam fora até uma etapa própria.
- A lista da Meta pode mudar de formato; a coluna `components` é guardada como veio (limite de 64 KB por template) e a elegibilidade falha fechada (`componente_nao_suportado`).
- Sincronização não é automática: roda sob pedido (e o cache envelhece; `stale` após 24 h). Rotina agendada fica para decisão futura.
