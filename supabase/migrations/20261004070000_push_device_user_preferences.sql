-- PUSH NOTIFICATIONS — uma linha por USUÁRIO em cada aparelho (preferências por usuário + aparelho no servidor).
--
-- Problema: com unique (endpoint, company_id), registrar o mesmo endpoint para OUTRO usuário reatribuía a linha e
-- zerava os setores. Os setores/nome do primeiro usuário se perdiam no servidor (só sobrava uma cópia local), então
-- ele não conseguia recuperá-los ao voltar ao aparelho depois de outro usuário.
--
-- Agora:
--   * unique (endpoint, company_id, user_id): UMA linha por usuário/empresa/aparelho. Cada linha guarda os
--     sector_ids e o device_name daquele usuário naquele aparelho, mesmo inativa (histórico).
--   * unique parcial (endpoint) where is_active: NUNCA existe mais de uma associação ATIVA por endpoint (entre
--     usuários e empresas). É a barreira de banco; a primeira é a transação do register com lock por endpoint.
--   * register_push_subscription: valida, trava o endpoint, desativa a associação ativa de qualquer OUTRO
--     usuário/empresa e reativa (ou cria) a linha do PRÓPRIO usuário. Nunca reatribui a linha de outro usuário.
--     Ao reativar, preserva device_name e sector_ids, revalidando os setores (ativos, da empresa, só production);
--     sem nenhum setor válido -> null = todos. Usuário que não é production fica sempre com sector_ids = null.
--
-- Não mudam: detach_push_endpoint (desativa tudo do endpoint), remove_push_subscription (só as linhas do próprio
-- usuário), my_push_devices (só as linhas do usuário atual, nunca endpoint/chaves), set_push_device_options (só a
-- linha do próprio usuário), push_event_targets (só linhas ativas) e todos os eventos/triggers/cron.
--
-- Dados existentes: nada é apagado. Relaxar o unique antigo não conflita com nenhuma linha. O índice parcial exige
-- no máximo 1 ativa por endpoint; se algum endpoint tivesse várias ativas (não há hoje), apenas as MENOS recentes
-- seriam DESATIVADAS (determinístico: updated_at, created_at, id), nunca excluídas.

-- ---------------------------------------------------------------------------
-- 1) Unique por (endpoint, empresa, usuário)
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_company_key;
alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_company_user_key unique (endpoint, company_id, user_id);

-- ---------------------------------------------------------------------------
-- 2) No máximo UMA associação ativa por endpoint
-- ---------------------------------------------------------------------------
-- Antes do índice: se houver endpoint com várias ativas, mantém só a mais recente (desativa, não apaga).
with ranked as (
  select id,
         row_number() over (partition by endpoint order by updated_at desc, created_at desc, id desc) as rn
  from public.push_subscriptions
  where is_active
)
update public.push_subscriptions s
   set is_active = false
  from ranked r
 where r.id = s.id and r.rn > 1;

create unique index push_subscriptions_one_active_per_endpoint
  on public.push_subscriptions (endpoint) where is_active;

comment on table public.push_subscriptions is
  'Aparelhos de Web Push: UMA linha por (endpoint, empresa, usuário), com os setores/nome daquele usuário naquele aparelho. No máximo UMA associação ativa por endpoint. endpoint/p256dh/auth são credenciais: sem acesso direto de clientes (só RPC e service_role).';

-- ---------------------------------------------------------------------------
-- 3) register_push_subscription (mesma assinatura): linha própria por usuário, setores preservados e revalidados
-- ---------------------------------------------------------------------------
create or replace function public.register_push_subscription(
  p_company_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_platform text default 'unknown',
  p_user_agent text default null,
  p_device_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_p256dh text := btrim(coalesce(p_p256dh, ''));
  v_auth text := btrim(coalesce(p_auth, ''));
  v_platform text := coalesce(nullif(btrim(coalesce(p_platform, '')), ''), 'unknown');
  v_name text := nullif(btrim(coalesce(p_device_name, '')), '');
  v_ua text := nullif(left(btrim(coalesce(p_user_agent, '')), 500), '');
  v_row public.push_subscriptions;
  v_sectors uuid[];
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;

  -- vínculo ATIVO na empresa informada (nunca empresa arbitrária)
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;

  if v_endpoint = '' or v_endpoint !~ '^https://' or char_length(v_endpoint) > 2000 then
    raise exception 'Aparelho inválido para notificações.' using errcode = 'PT400';
  end if;
  if v_p256dh = '' or v_auth = '' or char_length(v_p256dh) > 256 or char_length(v_auth) > 256 then
    raise exception 'Aparelho inválido para notificações.' using errcode = 'PT400';
  end if;
  if v_platform not in ('ios', 'android', 'desktop', 'unknown') then
    raise exception 'Plataforma inválida.' using errcode = 'PT400';
  end if;
  if v_name is not null and char_length(v_name) > 60 then
    raise exception 'O nome do aparelho pode ter no máximo 60 caracteres.' using errcode = 'PT400';
  end if;

  -- Lock por endpoint: dois logins/registros simultâneos no mesmo aparelho se serializam. (O índice parcial
  -- push_subscriptions_one_active_per_endpoint é a segunda barreira.)
  perform pg_advisory_xact_lock(hashtextextended('push-endpoint:' || v_endpoint, 0));

  -- Qualquer associação ATIVA de OUTRO usuário/empresa neste endpoint deixa de existir como ativa.
  update public.push_subscriptions
     set is_active = false
   where endpoint = v_endpoint
     and is_active
     and not (company_id = p_company_id and user_id = auth.uid());

  select * into v_row
  from public.push_subscriptions
  where endpoint = v_endpoint and company_id = p_company_id and user_id = auth.uid()
  for update;

  if found then
    -- Reativa a PRÓPRIA linha (nunca a de outro usuário). Setores salvos: revalidados contra a empresa e os setores
    -- ativos; só production os mantém; sem nenhum válido (array_agg vazio = null) vira "todos".
    v_sectors := null;
    if v_role = 'production' and v_row.sector_ids is not null then
      select array_agg(ps.id order by ps.id) into v_sectors
      from public.production_sectors ps
      where ps.company_id = p_company_id and ps.is_active and ps.id = any (v_row.sector_ids);
    end if;

    update public.push_subscriptions
       set p256dh = v_p256dh,
           auth = v_auth,
           platform = v_platform,
           user_agent = v_ua,
           device_name = coalesce(v_name, device_name),
           sector_ids = v_sectors,
           is_active = true,
           failure_count = 0,
           last_failure_at = null
     where id = v_row.id
     returning id into v_id;
  else
    insert into public.push_subscriptions (company_id, user_id, endpoint, p256dh, auth, platform, user_agent, device_name)
    values (p_company_id, auth.uid(), v_endpoint, v_p256dh, v_auth, v_platform, v_ua, v_name)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;
