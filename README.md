# Orça Fácil

SaaS multiempresa de orçamentos assistidos por IA, com WhatsApp como canal de entrada.

Arquitetura completa e roadmap em [docs/architecture.md](docs/architecture.md).

## Stack

- React + TypeScript + Vite (PWA) — `apps/web`
- Tipos/schemas compartilhados — `packages/shared`
- Supabase (Postgres + RLS, Auth, Storage, Edge Functions) — `supabase/`

## Desenvolvimento

```bash
npm install
npm run dev
```

## Estrutura

```
apps/web/        frontend (PWA)
packages/shared/ tipos e schemas compartilhados entre frontend e Edge Functions
supabase/        migrations e Edge Functions
```

## Status

Etapa 1 do roadmap (Fundação) em andamento: monorepo, scaffold do frontend e migration
inicial (`companies`, `company_users`, `profiles` + RLS). Nenhuma integração com IA ou
WhatsApp ainda.
