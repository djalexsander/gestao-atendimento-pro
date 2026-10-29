# Piloto controlado do Embedded Signup — allowlist por empresa (Etapa 7)

Migration: `supabase/migrations/20261107010000_whatsapp_signup_pilot_allowlist.sql` (**não aplicada em produção**; aguarda autorização).

## Camadas (todas obrigatórias)
1. Flag global `whatsapp_platform_settings.embedded_signup_enabled` (trava do operador; continua `false`).
2. Empresa na allowlist `whatsapp_signup_pilot_companies` com `authorized = true` (tabela nasce **vazia**; ninguém é autorizado automaticamente).
3. Usuário owner/admin ativo + módulo WhatsApp contratado.

A allowlist é conferida no banco em `whatsapp_signup_begin` (nova sessão), `whatsapp_signup_reserve` (consumo do state) e `whatsapp_signup_complete`
(conclusão), e de novo na Edge (`pilotAuthorized`, leitura direta da tabela com service_role): antes de qualquer chamada à Meta e antes do registro do número.
Falha na leitura = falha fechada. O frontend só reflete o estado (`whatsapp_get_module_state` → `signup.reason = 'company_not_authorized'`): botão
desabilitado, mensagem própria e o SDK da Meta nunca é carregado (só carrega após o clique no botão habilitado).

## Operação (somente Admin Master, via SQL/RPC autenticada — sem tela nesta etapa)
```sql
select public.master_whatsapp_pilot_set('<company_id>', true,  'motivo/observação');  -- autoriza
select public.master_whatsapp_pilot_set('<company_id>', false, 'motivo');             -- revoga
select public.master_whatsapp_pilot_list();                                           -- empresas da allowlist
select public.master_whatsapp_pilot_events('<company_id>');                           -- trilha: quem/quando
```
Todas exigem `assert_master_admin()`; `anon` e `service_role` não têm EXECUTE. As tabelas não têm acesso do cliente (RLS + sem grant).
Cada mudança grava `authorized_by/at`, `revoked_by/at` e um evento imutável em `whatsapp_signup_pilot_events`.

## Revogação
- Impede novas sessões; `reserve`/`complete` recusam (`company_not_authorized`).
- Falha as sessões `pending`/`reserved` (`pilot_revoked`) e apaga apenas o token de signup ainda **não ligado a conexão** e **sem operação externa em aberto** (ver a seção seguinte).
- **Não toca** em conexões (ativas ou antigas), tokens ligados a conexões, PINs, registros de número, mensagens, IA ou atendimento.
- Idempotente; reautorizar zera a revogação atual e mantém a trilha.

## Revogação durante o onboarding (Etapa 7.1)
Cenário: empresa autorizada inicia o signup, o backend já conversa com a Meta, o Admin Master revoga e a resposta da Meta chega depois.
- **Conexão nunca é ativada:** `whatsapp_signup_complete` recusa (`company_not_authorized` / sessão já `failed`) e a Edge confere a allowlist três vezes
  (antes da Meta, antes do registro do número e antes de assinar o webhook). Depois da revogação a Edge **não assina o webhook** nem faz novo registro.
- **Efeito já feito na Meta fica registrado e recuperável:** a resposta tardia ainda é gravada em `whatsapp_registration_finish_attempt`
  (`registered` ou `uncertain`), com o PIN preservado no Vault. Reautorizar e reconectar **não repete** o registro concluído; um registro `uncertain`
  continua exigindo conferência humana (`whatsapp_registration_resolve`).
- **Token e PIN não são apagados com operação externa em aberto:** `whatsapp_signup_external_op_open(session)` é verdadeiro enquanto o registro
  ligado à sessão estiver `in_progress` ou `uncertain`. Nesse caso `whatsapp_signup_fail` (inclui a revogação) e `whatsapp_signup_sweep` mantêm o token
  da sessão encerrada; quando o registro é resolvido, a varredura seguinte remove o token. (Essa regra vale para todo encerramento de sessão, não só revogação.)
- **Sem nova tentativa:** com a sessão encerrada, `begin_attempt` recusa; a Edge nunca repete o registro sozinha.

## Testes
`.claude/db-tests/whatsapp-signup-pilot.mjs` (banco real + handler real + Meta simulada), `mutate-whatsapp-signup-pilot.mjs`, rollback
`whatsapp-signup-pilot.rollback.sql` (gerado por `gen-pilot-rollback.mjs`) e `.claude/frontend-tests/whatsapp-signup-ui.mjs`.
