# WhatsApp + IA — cardápio em PDF (documento por media_id)

Status: migration `20261101010000` APLICADA em produção (2026-10-27); Edge `whatsapp-ai-auto` v20; `menu_pdf_enabled` ligada SÓ na Djalexeventos (envio real homologado). Release v1.0.12.

## Fluxo
1. A saudação inicial (1ª saída da conversa, template, sem IA) pode **oferecer** o cardápio ("Se quiser, posso enviar o nosso cardápio em PDF."). Uma vez por conversa. A oferta só é registrada depois que a Meta aceitou a mensagem.
2. O PDF só é enviado quando o cliente **pede** ("me manda o cardápio", "quero ver o menu", "o que vocês têm?") ou **aceita** uma oferta **pendente** ("sim", "pode mandar"). Decisão determinística (`_shared/ai-menu.ts`), sem IA e sem cota.
3. Oferta pendente = a oferta é a **última saída** da conversa, tem < 24 h e nada foi enviado depois. Qualquer outra resposta (IA ou humano) a invalida.
4. Worker (`whatsapp-ai-auto`): contexto (`whatsapp_ai_menu_context`) → PDF do cache (hash do catálogo) ou gerado (`_shared/menu-pdf.ts`, sem dependências) e guardado no bucket privado `whatsapp-menu/<empresa>/<hash>.pdf` → `whatsapp_ai_menu_commit_send` (reaproveita `whatsapp_ai_auto_commit_send`: módulos, modo auto, atendimento humano, janela 24 h, modo teste, mensagem nova, uma saída por job; vira `type='document'` na mesma transação) → dispatch: upload `POST /{phone_number_id}/media` + mensagem `type=document` com `media_id`, `filename` e legenda. Sem link externo.
5. Depois do envio o atendimento segue normal (próximas mensagens passam pelo fluxo de pedidos/IA de sempre).

## Regras de dados
- Produtos reais: ativo + categoria ativa; no modo `live` (`ai_availability_mode`), também à venda e com saldo. Ordem: categoria (`sort_order`, nome) e produto (nome). Nome, descrição e preço atuais; sem cadastro paralelo.
- Cache: `whatsapp_menu_pdfs` (hash md5 do catálogo filtrado + nome da empresa). Preço/descrição/nome/ativação/categoria mudam o hash e o PDF é regerado; mudanças irrelevantes (updated_at) não.
- Se o catálogo mudar entre a geração e o commit: `stale` → o job é retomado e gera o PDF novo.

## Segurança
- `company_whatsapp_ai_settings.menu_pdf_enabled` (default **false**, ligada por SQL) + módulos `whatsapp` e `ia` + modo auto. Sem `deps.menu` (storage) a funcionalidade não existe.
- RPCs só `service_role`; tabelas com RLS e sem acesso de clientes; bucket privado sem políticas; caminho `<empresa do job>/<hash>.pdf` validado no banco.
- Falhas (storage, upload, envio): mensagem `failed` (`media_*`/`graph_*`) ou job `failed_send` (`menu_pdf_unavailable`, com handoff se permitido); nada é dito ao cliente como enviado antes da Meta aceitar.
- Idempotência: um job → no máximo uma saída (índice único); webhook duplicado não cria 2º job; retry devolve `existing`.

## Testes (locais)
`db-tests/whatsapp-menu-pdf-e2e.mjs` (96), `mutate-whatsapp-menu-pdf.mjs` (34/34 mortos), `frontend-tests/whatsapp-menu-pdf-logic.mjs` (83). Regressão: banco 5990 ok, `acl2` OK, front/Edge 2497 ok (após ajustar 2 guardas estáticas de "arquivo não alterado").

## Pendências / riscos
- Sem teste real na Meta (upload/document reais) nem Deno `deploy`; o adapter segue a documentação, validar em staging com o número de teste.
- Logo da empresa **não** entra no PDF: `companies.logo_url` não é usado nem validado hoje (embutir exigiria buscar URL externa).
- Não testado com rascunho de pedido ativo (a rota do menu não toca rascunhos/pedidos; confirmar em homologação).
- Publicação: migration (dry-run primeiro) → deploy `whatsapp-ai-auto` → `update ... set menu_pdf_enabled=true` só na empresa de teste → homologação com Meta real.
