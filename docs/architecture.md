# Arquitetura — Orça Fácil

> Documento de arquitetura aprovado antes do início da implementação. Mantido no repo
> para acompanhar decisões à medida que o projeto evolui.

Princípio central do produto: **IA interpreta, sistema calcula**. A IA nunca decide preço
final nem envia orçamento ao cliente sem aprovação humana.

## 1. Arquitetura recomendada

- **Monorepo** (npm workspaces) com três áreas: `apps/web` (PWA React), `packages/shared`
  (tipos/schemas compartilhados) e `supabase/` (migrations + Edge Functions).
- **Frontend**: React + TypeScript + Vite, TanStack Query, React Router, Tailwind CSS +
  shadcn/ui, Zod para validação de formulários.
- **Backend = Supabase**: Postgres com RLS como fonte da verdade; Edge Functions (Deno)
  para tudo que exige segredo/lógica sensível: webhook do WhatsApp, chamada à IA, motor
  de cálculo de orçamento, geração de PDF, jobs agendados (`pg_cron`). Sem servidor
  Node/Express próprio.
- **IA**: chamada a partir de Edge Function apenas (nunca do frontend), usando a API da
  Anthropic com saída estruturada (tool use / JSON Schema). Chave de API em Supabase
  Secrets.
- **Canal de mensagens**: camada de adaptador (`ChannelAdapter`) desacoplada — hoje
  Simulador, amanhã WhatsApp Cloud API.
- **Deploy**: frontend no Vercel/Cloudflare Pages (deploy automático via GitHub);
  banco/functions no Supabase via CLI + GitHub Actions.

## 2. Estrutura de pastas

```
orca-facil/
  apps/
    web/
      src/
        app/                # rotas, layout, providers
        features/
          budgets/
          conversations/
          catalog/
          customers/
          settings/
        components/ui/
        lib/
        hooks/
        pwa/
      public/
  packages/
    shared/
      src/
        schemas/
        types/
  supabase/
    migrations/
    functions/
      inbound-message/
      whatsapp-webhook/
      ai-interpret-message/
      budget-engine/
      generate-pdf/
      expire-quotes/
  .github/workflows/
```

## 3. Modelo inicial do banco

Produtos e serviços foram unificados em `catalog_items` (`kind`: product|service), status
do orçamento é uma coluna enum (não uma tabela), e o log de mudanças fica em uma tabela
genérica `audit_logs`.

| Tabela | Propósito |
|---|---|
| `companies` | empresa (tenant) |
| `company_users` | vínculo usuário↔empresa + papel (owner/admin/agent) |
| `profiles` | dados extra do usuário (1:1 com `auth.users`) |
| `customers` | clientes da empresa |
| `customer_contacts` | canais do cliente (whatsapp/email/telefone) |
| `categories` | categorização do catálogo |
| `catalog_items` | produtos e serviços |
| `packages` / `package_items` | pacotes comerciais |
| `pricing_rules` | regras comerciais (deslocamento, faixas, sazonalidade, desconto máx.) |
| `conversations` / `messages` | canal de comunicação com o cliente |
| `ai_extractions` | interpretação estruturada da IA para uma mensagem |
| `quotes` / `quote_items` / `quote_revisions` | orçamento, itens e histórico |
| `whatsapp_configs` | config do WhatsApp por empresa |
| `ai_configs` | config e limite de uso de IA por empresa |
| `audit_logs` | auditoria genérica |

`quote.status`: `draft → pending_review → approved → sent → viewed → accepted/declined
→ expired`.

Implementado até agora (migration `20260923000001_init_core_tables.sql`): `companies`,
`company_users`, `profiles` + funções e policies de RLS. As demais tabelas entram em
migrations das próximas etapas do roadmap (seção 13).

## 4. Relacionamento entre as principais tabelas

```
companies 1─N company_users N─1 auth.users
companies 1─N customers 1─N customer_contacts
companies 1─N categories 1─N catalog_items
companies 1─N packages 1─N package_items N─1 catalog_items
companies 1─N pricing_rules
companies 1─N conversations N─1 customers
conversations 1─N messages
messages 1─1 ai_extractions
conversations 1─N quotes N─1 customers
quotes 1─N quote_items N─1 catalog_items (nullable)
quotes 1─N quote_revisions
companies 1─1 whatsapp_configs
companies 1─1 ai_configs
companies 1─N audit_logs
```

## 5. Estratégia multiempresa / RLS

- Função `SECURITY DEFINER` `public.user_company_ids()` retorna os `company_id` do
  `auth.uid()` atual via `company_users` — usada em todas as policies.
- Policy padrão em tabela de tenant:
  `USING (company_id IN (SELECT public.user_company_ids()))`.
- `public.user_role_in_company(company_id)` controla ações sensíveis por papel
  (owner/admin/agent).
- **GRANTs explícitos por migration**, nunca implícitos:
  - `authenticated`: acesso direto às tabelas que o app usa do cliente, sempre limitado
    pelas policies de RLS.
  - `anon`: nenhum grant direto em tabelas internas. Acesso público a um orçamento
    (link compartilhável) passa por uma função `SECURITY DEFINER`
    (`get_public_quote(token)`) com `GRANT EXECUTE ... TO anon`.
  - `service_role`: usado só dentro de Edge Functions; isolamento por `company_id` é
    responsabilidade explícita do código da function.
- Criação de empresa passa pela RPC `public.create_company()` (atômica: cria a empresa e
  o vínculo `owner`), evitando policies de INSERT abertas em `companies`.

## 6. Arquitetura da IA

Duas Edge Functions com responsabilidades separadas:

1. **`ai-interpret-message`** — interpreta a mensagem e devolve dados estruturados
   (evento, data, itens solicitados, campos faltantes). Nunca escreve em
   `quotes`/`quote_items`, nunca calcula preço.
2. **`budget-engine`** — função determinística que transforma uma extração aprovada +
   catálogo + `pricing_rules` da empresa em um orçamento rascunho. Preço, quantidade e
   regras vêm sempre de dados cadastrados.

Guardrails: itens citados pela IA são casados contra o catálogo real da empresa (item não
reconhecido vira `missing_fields`); limite mensal de tokens por empresa (`ai_configs`)
verificado antes de cada chamada.

## 7. Pipeline de mensagens

```
Simulador ─┐
           ├─► inbound-message ─► messages ─► ai-interpret-message ─► ai_extractions
WhatsApp ──┘                                                          │
                                                                       ▼
                                                    Inbox: funcionário revisa
                                                                       │
                                                          aciona budget-engine
                                                                       │
                                                        quote (draft) → aprovação
                                                                       │
                                                    adapter de canal envia (status=sent)
```

`inbound-message` é o único ponto de entrada da lógica de negócio, chamado tanto pelo
simulador quanto pelo webhook real do WhatsApp. Nenhum orçamento é enviado ao cliente sem
aprovação humana explícita.

## 8. Simulador de WhatsApp

Tela de chat mockada dentro do painel. Ao "enviar como cliente", o frontend chama a mesma
function `inbound-message` que o webhook real chamaria, com `channel='simulator'`.
Permite construir e validar toda a inteligência antes de existir qualquer integração real.

## 9. Entrada futura da API oficial do WhatsApp

`whatsapp-webhook` decodifica o payload da Cloud API, normaliza para o mesmo formato de
`inbound-message` e reusa o pipeline central. `WhatsAppAdapter.sendMessage()` envia via
Graph API. Migrar uma empresa do simulador para o WhatsApp real é só trocar
`whatsapp_configs.mode` e cadastrar credenciais.

## 10. Estratégia de PWA

`vite-plugin-pwa` com `registerType: 'prompt'`; manifest com ícones maskable; banner
"Nova versão disponível" com botão "ATUALIZAR AGORA" (`skipWaiting()` + reload). Shell da
app em network-first (prioriza sempre a versão mais nova).

## 11. Deploy independente do Lovable

Frontend no Vercel/Cloudflare Pages com deploy automático a cada push em `main`.
Banco/Functions no Supabase Cloud, migrations em `supabase/migrations`, aplicadas via
GitHub Actions (`supabase db push` + `supabase functions deploy`) usando
`SUPABASE_ACCESS_TOKEN` como secret do repositório.

## 12. Custos

Supabase free tier + Vercel/Cloudflare Pages free tier + domínio próprio cobrem o MVP.
IA cobrada por uso (modelo econômico para interpretação, limite mensal por empresa).
WhatsApp Cloud API só entra em custo real na fase 9 (saindo do simulador). Sem servidor
próprio.

## 13. Roadmap do MVP

1. **Fundação** — monorepo, scaffold do frontend, migration base + RLS. *(em andamento)*
2. **Auth & multiempresa** — cadastro cria empresa + owner, seletor de empresa, layout do
   dashboard.
3. **Catálogo** — categorias, itens, pacotes, regras de preço + CRUD.
4. **Clientes** — clientes + contatos.
5. **Pipeline de mensagens** — conversas, mensagens, simulador, `inbound-message`.
6. **IA de interpretação** — `ai-interpret-message`, `ai_extractions`, limite de uso.
7. **Motor de orçamento** — `budget-engine`, revisão/aprovação, revisões, auditoria.
8. **Orçamento apresentável** — página pública, PDF, link compartilhável, expiração.
9. **PWA + deploy automático**.
10. **WhatsApp oficial** (futuro/opcional).
11. **Hardening** — rate limiting, auditoria, consumo de IA, testes automatizados.

Cada etapa é implementada e revisada antes da próxima.
