# Contatos manuais do WhatsApp — plano de publicação (Etapa 7.10G.1, auditoria)

Estado em 2026-11-16: **nada foi aplicado nem publicado**. Este documento é o plano para a Etapa 7.10G, que só começa com autorização explícita.

## 1. O que muda

**Banco (4 migrations novas, nesta ordem, todas aditivas):**

| # | Arquivo | Efeito |
|---|---|---|
| 1 | `20261127010000_whatsapp_contacts_manual.sql` | tabelas `whatsapp_contacts` e `whatsapp_contact_events` (RLS ligado, sem política, sem grant a anon/authenticated), 3 funções internas, triggers, constraints |
| 2 | `20261128010000_whatsapp_contacts_manual_rpcs.sql` | 6 RPCs públicas (só `authenticated`) + 3 auxiliares internas |
| 3 | `20261129010000_whatsapp_contacts_unified_search.sql` | `CREATE OR REPLACE` de `whatsapp_contacts_query` (mesma assinatura; corpo novo) |
| 4 | `20261129020000_whatsapp_contacts_archived_list.sql` | RPC de leitura `list_archived_whatsapp_contacts` |

Nenhuma tabela, coluna, política, trigger ou função **existente** é alterada, exceto o corpo de `whatsapp_contacts_query` (usada só por `list_`/`search_whatsapp_contacts`, isto é, só pela tela de Contatos).

**Frontend:** `WhatsappContacts.tsx`, `WhatsappContactsView.tsx`, `whatsappContactsApi.ts`, `whatsappContactsLogic.ts`, `whatsappContactsPresentation.ts`, `index.css` (alterados) e `WhatsappManualContactsUi.tsx`, `whatsappManualContactsApi.ts`, `whatsappManualContactsLogic.ts`, `whatsappManualContactsUiLogic.ts` (novos).

**Docs/rollbacks versionáveis:** `supabase/rollbacks/whatsapp-contacts-manual/`, `-manual-rpcs/`, `-unified-search/`, `-archived-list/` e `docs/whatsapp-contatos-exclusao-definitiva.md` (especificação, nada implementado).

**Não versionar:** `artifacts/`, `docs/capturas-*` (inclusive as 7-10f e 7-10f1, que são fictícias), `docs/catalogo-teste-*`, `scripts/prepare_djalex_catalog_images.py` — são anteriores/alheios e ficam como estão.

## 2. Ordem obrigatória

1. **Migrations primeiro, frontend depois.** O frontend novo chama RPCs que ainda não existem no remoto (criar, editar, arquivar, listar arquivados). Publicado antes do banco, "Novo contato" e a aba Arquivados dariam erro. Já o frontend **atual** (6e52ef2) continua funcionando com o banco novo: sem contatos manuais, a busca devolve o mesmo conteúdo da 7.2 (campos novos são ignorados por ele).
2. O workflow `deploy-supabase.yml` **não aplica nada hoje**: os secrets `SUPABASE_ACCESS_TOKEN` e `SUPABASE_DB_PASSWORD` não existem no repositório (a última execução registra "deploy ignorado"). Mesmo que fossem criados, o workflow só aplica se as pendências forem exatamente os arquivos novos do push; com as migrations aplicadas à mão antes, ele vê "up to date". **Não criar esses secrets durante a publicação.**

## 3. Passo a passo (7.10G)

**A. Pré-voo (somente leitura, repetir no dia)**
1. `git status` limpo de surpresas; `git fetch` e conferir `main == origin/main`.
2. `supabase migration list --linked`: devem aparecer só as 4 pendentes.
3. `supabase db push --linked --dry-run --skip-vault`: lista exatamente as 4.
4. `db query --linked -f .claude/remote/pre-710g-readonly.sql`: tabelas/funções novas ainda inexistentes, dependências presentes, `whatsapp_contacts_query` com md5 `bbaa77ef5b4fe7fb54395f71f4eb94ec` (= corpo da 7.2) e sem locks pendentes.
5. `node .claude/remote/acl-snapshot.mjs pre-710g-dia` (snapshot de funções, tabelas, RLS, políticas, triggers).
6. Janela de baixa atividade (hoje: 2 conexões WhatsApp ativas, 3 empresas, 2 conversas ativas, 273 mensagens).

**B. Aplicação (autorização explícita, uma migration por vez)**
```bash
node node_modules/@supabase/cli-windows-x64/bin/supabase.exe db push --linked --yes --skip-vault
```
(aplica as 4 em ordem; cada arquivo roda em uma transação, então uma falha não deixa meio-estado). Alternativa mais cautelosa: um workdir temporário com uma migration por vez (`--workdir`), validando entre elas.

**C. Validação pós-aplicação (somente leitura + 1 dry-run)**
1. `migration list` sem pendências; `db push --dry-run` = "up to date".
2. `acl-snapshot.mjs pos-710g` e `--diff pre-710g pos-710g`: devem aparecer **apenas** 13 funções novas, 2 tabelas novas e `whatsapp_contacts_query` com corpo diferente (ACL idêntica); nada mais.
3. Catálogo: 13 funções novas com `SECURITY DEFINER` + `search_path = public`, EXECUTE só para `authenticated` nas 7 públicas e fechado nas 6 internas; RLS ligado nas 2 tabelas, 0 políticas, 0 grants a anon/authenticated.
4. Conferir que `list_whatsapp_contacts`/`search_whatsapp_contacts` continuam executáveis só por `authenticated`.
5. Contagens: conversas, mensagens, clientes, conexões e jobs de IA idênticos às de antes; `whatsapp_contacts` e `whatsapp_contact_events` com 0 linhas.
6. Testes funcionais **no navegador, com login do próprio dono** (nunca criar contas nem digitar senhas): lista atual igual à de antes; criar um contato de teste claramente identificado, vinculá-lo, arquivá-lo e restaurá-lo; depois arquivar e **excluir o rastro** só por procedimento aprovado (não há exclusão definitiva no app: o contato de teste pode ficar arquivado, ou ser removido por SQL manual do dono). Qualquer escrita de teste na produção exige autorização separada.

**D. Publicação do frontend (somente depois de C)**
1. `npm run lint`, `npm run build` (CI roda os dois).
2. Commit apenas dos arquivos do item 1 (frontend, migrations, rollbacks, spec); push em `main`. O push toca `supabase/migrations/**`, então o workflow roda: espera-se "secrets não configurados: deploy ignorado" (ou, se existirem, "up to date").
3. Acompanhar CI e a implantação do frontend (Vercel); conferir a tela em produção com login do dono.
4. Sem tag, sem release, sem instalador Desktop (o Desktop empacota o mesmo frontend; decidir versão à parte).

## 4. Rollback

Ordem inversa e **cada passo independente**:

| Situação | Ação |
|---|---|
| Problema só na aba Arquivados | `supabase/rollbacks/whatsapp-contacts-archived-list/20261129020000_rollback.sql` (1 `DROP FUNCTION IF EXISTS`); reverter o frontend junto |
| Problema na busca unificada | `.../whatsapp-contacts-unified-search/20261129010000_rollback.sql` restaura o corpo publicado na 7.2 (md5 `bbaa77ef…`); contatos manuais seguem gravados mas somem da busca |
| Problema nas RPCs | `.../whatsapp-contacts-manual-rpcs/20261128010000_rollback.sql` (9 `DROP FUNCTION IF EXISTS`); dados preservados |
| Desfazer tudo | os 4 em ordem inversa; por último `.../whatsapp-contacts-manual/20261127010000_rollback.sql`, que **apaga as tabelas e os contatos manuais** (perda de dados: exportar antes se houver contatos reais) |

Depois de qualquer rollback: `migration repair --status reverted <versão> --linked` para poder reaplicar. Se o frontend já estiver publicado, reverter o frontend para `6e52ef2` (que continua compatível com o banco de qualquer um dos estados acima).

O ciclo completo (aplicar 4, usar, reverter 4, reaplicar 4) foi simulado em PGlite: catálogo idêntico ao original depois dos rollbacks e idêntico ao "aplicado" depois de reaplicar.

## 5. Riscos e mitigação

- **WhatsApp / Coexistence / IA / webhooks / mensagens / conexões:** nenhum arquivo de Edge Function ou tabela dessas áreas é tocado; só a tela de Contatos usa as RPCs alteradas. Risco de interrupção: nulo no desenho; mitigado pelo diff de snapshot e pelas contagens no passo C.
- **Locks:** `CREATE TABLE` com chaves estrangeiras para `companies`, `customers` e `auth.users` toma lock curto nessas tabelas (milissegundos, tabelas novas e vazias). Sem locks pendentes hoje.
- **`customers`:** o vínculo usa FK `NO ACTION`, como as demais. Excluir um cliente ligado a contato manual passa a ser recusado pelo banco, e `delete_customer` (20261114010000) captura `foreign_key_violation` e devolve PT409 "possui registros vinculados. Use Inativar…": mensagem correta e sem perda de dados (testado: `customer-delete` 49 checks e 28/28b da 7.10B).
- **Desempenho:** volume atual é minúsculo. Em PGlite (mais lento que Postgres nativo), 35 mil origens ≈ 1,3 s por consulta; custo linear, sem índice novo necessário hoje. Arquivados: 12 ms com 5 mil contatos.
- **Dados pessoais:** auditoria não grava nome, telefone nem observações; observações só saem no detalhe.
- **Cache do PWA/Desktop:** abas abertas com o frontend antigo seguem funcionando (compatível); atualizam no próximo carregamento.
