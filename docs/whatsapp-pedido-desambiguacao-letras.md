# Desambiguação por letras (A–E) e tolerância a erro de digitação — pedido automático (WhatsApp)

Status: migration `20261027010000_whatsapp_order_choice_context.sql` aplicada e `whatsapp-ai-auto` publicado (v18) em 2026-10-21.

## Fluxo
`whatsapp-webhook` → `whatsapp_ingest_message` (deduplica por id do provedor) → job → `whatsapp-ai-auto` → `runOrderFlow` (`_shared/ai-order-flow.ts`) → RPCs `whatsapp_order_*`.

1. Cliente: "quero 2 haineken". O extrator devolve `add_item` com o texto do produto; `whatsapp_order_resolve_item` resolve em etapas: todos os termos no nome → sem descritores genéricos (lata, normal…) → **erro de digitação** (termos de 5+ letras aceitam 1 erro, 8+ aceitam 2; distância de edição própria, sem extensão) → `near`.
   - Um candidato por erro de digitação entra direto (o resumo mostra o item antes do CONFIRMAR); vários => pergunta por letras; mais de 5 => pede um detalhe.
2. Pergunta: `Encontrei algumas opções de haineken:` / `A) …` / `B) …` / `Qual você prefere? Responda A, B ou C.` (nomes reais, ordem estável por nome, no máximo 5).
3. Contexto em `whatsapp_order_choices` (empresa, conversa, mensagem gatilho, rascunho aberto, texto original, quantidade, observação, ids reais por letra, status pendente/resolvido/cancelado/expirado, criação e expiração de 30 min). Um pendente por conversa (índice único parcial); reprocessar a mesma mensagem reaproveita o contexto.
4. Resposta ("A", "a", "opção A", "quero a A", "a primeira", ou o nome) é interpretada **antes** do modelo e só com contexto ativo. Resolver usa o catálogo de AGORA (produto desativado não entra em silêncio), é idempotente pela mensagem e, na MESMA transação da escolha, aplica `add_item` com a quantidade/observação guardadas (`apply_ops`); se não puder adicionar, nada é marcado como resolvido. Os itens já no rascunho não são tocados. A lista repetida mostra só as opções ainda ativas, com as letras originais. Letra fora da lista, nome ambíguo ou resposta ininteligível repetem a lista; na 3ª pergunta seguida cancela o contexto e encaminha (`order_unresolved`). Contexto expirado + letra solta: "Essa pergunta expirou…". Outra instrução cancela o contexto.
5. Compatibilidade: perguntas antigas (bullets "•") ainda no histórico continuam sendo lidas pelo caminho antigo, sem contexto no banco.

## Segurança
RPCs `SECURITY DEFINER`, `search_path = public`, `EXECUTE` só para `service_role`; empresa e conversa vêm sempre do JOB; tabela com RLS (leitura só owner/admin da empresa), sem `INSERT/UPDATE/DELETE` para `authenticated`/`anon`; função de distância de edição fechada a todos os papéis. Pedido oficial só no CONFIRMAR normal.

## Limitação conhecida
Se UMA mensagem trouxer duas ambiguidades, só a primeira vira pergunta por letras; a outra recebe um aviso para o cliente dizer depois qual quer.

## Testes
`whatsapp-order-drafts` 377, `whatsapp-order-e2e` 138, `whatsapp-order-logic` 90, `order-engine-upgrade` 22, mutação da migration 13/13 (`mutate-order-choice-context.mjs`), frontend/Edge 2274. Typecheck oficial: `tsc -p apps/web/tsconfig.app.json --noEmit`. Smoke sintético em produção (worker real): pedido completo com letra A, letra inválida, resposta ininteligível, expiração, produto desativado, webhook duplicado, isolamento, letra sem contexto e typo com candidato único.
