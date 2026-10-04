# Notificações push (Web Push) — Gestão Atendimento Pro

Estado: **implementado só localmente**. Nada foi aplicado no Supabase, nenhuma Edge Function foi publicada, nenhum
secret/VAPID foi definido e o cron não está ativo. Este arquivo descreve o que será necessário e a ordem.
**Nenhum valor real de segredo vai neste arquivo, no git ou no frontend.**

## Como funciona

```
operação (pedido, item pronto, cancelamento, resumo financeiro)
 → gatilho grava push_events (dedupe por empresa + chave)
 → push_dispatch_event: UMA chamada assíncrona (pg_net) à Edge Function push-dispatch
 → push-dispatch reivindica o evento (pending → sending, atômico), resolve os destinatários NO SERVIDOR,
   envia o Web Push e registra o resultado de cada aparelho
 → cron (a cada minuto) reenvia eventos pendentes/travados; resumo financeiro às 08:00 de São Paulo
```

O frontend só registra o aparelho (`register_push_subscription`) e pede a notificação de teste (`push-test`).
Quem recebe o quê é decidido sempre no servidor (aparelho ativo + vínculo ativo + papel + setor, da mesma empresa).

| Evento | Quem recebe (v1) | Toque abre |
|---|---|---|
| Novo pedido | `production` (aparelho: todos os setores ou os escolhidos) | `/operacional/producao` |
| Pedido pronto (pedido COMPLETO) | o `attendant` que enviou o pedido | `/operacional/atendimento/:sessionId` |
| Item cancelado já em preparo/pronto | `production` do setor do item | `/operacional/producao` |
| Resumo diário a receber / a pagar | `owner` e `admin` | `/app/financeiro/contas-a-receber` / `contas-a-pagar` |

Owner/admin não recebem pedidos. Cashier não recebe nada na v1.

## Secrets necessários (valores NUNCA no git)

**Edge Functions** (Supabase → Edge Function secrets, projeto `endbovcvhfvaynqjronl`):

| Nome | O que é |
|---|---|
| `VAPID_PUBLIC_KEY` | chave pública VAPID |
| `VAPID_PRIVATE_KEY` | chave privada VAPID (só aqui) |
| `VAPID_SUBJECT` | `mailto:um-email-valido@dominio` (a Apple exige subject válido) |
| `PUSH_DISPATCH_SECRET` | segredo compartilhado, no mínimo 32 caracteres |

**Supabase Vault** (lido pela função `push_dispatch_event`, nomes exatos):

| Nome | Valor |
|---|---|
| `PUSH_DISPATCH_URL` | `https://endbovcvhfvaynqjronl.supabase.co/functions/v1/push-dispatch` |
| `PUSH_DISPATCH_SECRET` | o MESMO valor do secret da Edge `PUSH_DISPATCH_SECRET` |

**Frontend / Vercel** (variável pública): `VITE_VAPID_PUBLIC_KEY` = a mesma chave pública.
Também no `.env` local para testar (o arquivo `.env` não é versionado).

## Ordem de aplicação (futura, uma etapa por vez, sempre com aprovação)

1. Gerar o par VAPID localmente (por exemplo `npx web-push generate-vapid-keys`) **sem salvar a chave privada em
   arquivo do repositório**; copiar direto para os secrets.
2. Definir os secrets da Edge e `VITE_VAPID_PUBLIC_KEY` (Vercel e `.env` local).
3. `supabase db push --linked --dry-run` e depois `--linked`: aplica `20261004030000_push_subscriptions.sql` e
   `20261004040000_push_events_dispatch.sql` (esta cria a extensão `pg_net`). **Não** aplicar ainda a
   `20261004050000_push_cron.sql` (agendamento).
4. Deploy das Edge Functions (sem Docker, sem `--prune`):
   `supabase functions deploy push-test --project-ref endbovcvhfvaynqjronl --use-api` e
   `supabase functions deploy push-dispatch --project-ref endbovcvhfvaynqjronl --use-api`.
   O `config.toml` já traz `push-test` com `verify_jwt = true` e `push-dispatch` com `verify_jwt = false`.
5. Cadastrar `PUSH_DISPATCH_URL` e `PUSH_DISPATCH_SECRET` no Vault (SQL com `vault.create_secret(...)`, executado uma
   vez, com o valor digitado na hora; não versionar o comando preenchido).
6. Publicar o PWA e validar o teste manual (abaixo).
7. Só depois do teste e de pedidos reais: aplicar `20261004050000_push_cron.sql` (ativa o resumo às 08:00 SP =
   11:00 UTC e o retry por minuto).

## Validação (por plataforma)

1. Em `Configurações → Notificações` (owner/admin) ou no botão **Notificações** das telas operacionais:
   **Ativar notificações** (a permissão só é pedida nesse clique) → **Enviar notificação de teste**.
2. Esperado: "Gestão Atendimento Pro — Notificações ativadas com sucesso."; ao tocar, abre o sistema.
3. **Android (Chrome/Edge):** com o PWA instalado e com o app fechado.
4. **iPhone/iPad:** iOS 16.4+ e PWA **instalado na Tela de Início** (no Safari comum a tela pede para instalar e não
   pede permissão). Permissão por toque; toque na notificação abre o app (a navegação usa `postMessage`, não
   `client.navigate`).
5. **Desktop (Chrome/Edge):** navegador aberto ou em segundo plano.
6. Pedido real: com um `production` ativado, enviar um pedido de um atendente e conferir a push e o toque.
7. A entrega depende do aparelho e do sistema (economia de bateria, modo Foco, permissões): **não é garantida nem
   instantânea**.

## Limpeza e segurança

- 404/410 no envio desativam o aparelho na hora; outras falhas somam `failure_count` e 5 seguidas desativam.
- Logout tenta desativar o aparelho (máx. 2 s, nunca bloqueia). Mesmo se falhar, vínculo inativo não recebe push.
- `endpoint`, `p256dh` e `auth` são credenciais: nenhum papel de cliente lê a tabela (só RPCs seguras e `service_role`).
- O dedupe é em 3 níveis: `(company_id, dedupe_key)` no banco, claim atômico no despacho e `tag` no service worker.
