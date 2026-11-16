-- Etapa 7.10C (LOCAL, NÃO aplicada): RPCs dos contatos MANUAIS do WhatsApp. Migration ADITIVA: só funções novas (depende da 20261127010000).
-- Cria: create_/update_/get_/archive_/restore_whatsapp_contact e set_whatsapp_contact_customer (públicas, só authenticated) e 3 auxiliares
-- internas. NÃO altera tabelas, políticas, triggers nem funções existentes, NÃO muda a busca de Contatos (7.10D), NÃO há interface,
-- NÃO toca em conversas, mensagens, IA, Coexistence, webhooks, conexões nem sincronização, e NÃO envia mensagem alguma.
--
-- Permissões (aprovadas): leitura (get) = owner, admin, attendant, cashier; criar/editar/vincular = owner, admin, attendant; arquivar/restaurar =
-- owner, admin. Cashier só lê. Observações visíveis a quem lê. Toda função: sessão (PT401), empresa do usuário (PT404, sem revelar outra empresa),
-- módulo WhatsApp (PT403) e papel (PT403); escrita ainda respeita o modo somente leitura da empresa (PT402).
-- Escrita direta nas tabelas continua impossível (sem grants): só estas RPCs gravam.
--
-- Duplicidade: INSERT ... ON CONFLICT DO NOTHING no índice único parcial (empresa, chave) e UPDATE com captura de unique_violation: a decisão é do
-- banco, então vale também sob concorrência. O erro (PT409) leva o id do contato ativo existente em DETAIL (da mesma empresa).
-- Auditoria: whatsapp_contact_events SEM dados pessoais: só os NOMES dos campos alterados (nunca nome, telefone ou texto das observações);
-- vínculo de cliente grava só o id do cliente.

-- ---------------------------------------------------------------------------
-- 1) Auxiliares internas (sem EXECUTE para clientes)
-- ---------------------------------------------------------------------------
create function public.whatsapp_contacts_assert_writer(p_company_id uuid, p_manage boolean)
returns public.company_role
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
begin
  v_role := public.whatsapp_assert_reader(p_company_id);   -- sessão, empresa do usuário, papel leitor e módulo WhatsApp
  if p_manage then
    if v_role not in ('owner', 'admin') then
      raise exception 'Somente donos e administradores podem arquivar ou restaurar contatos.' using errcode = 'PT403';
    end if;
  elsif v_role not in ('owner', 'admin', 'attendant') then
    raise exception 'Você não tem permissão para cadastrar ou editar contatos.' using errcode = 'PT403';
  end if;
  if public.company_write_blocked(p_company_id) then
    raise exception 'Empresa em modo somente leitura (%). Regularize a contratação/pagamento para voltar a registrar alterações.',
      public.company_access_state(p_company_id) using errcode = 'PT402';
  end if;
  return v_role;
end;
$$;

-- Contato + barreira de empresa (PT404 igual para inexistente e de outra empresa: nunca revela existência)
create function public.whatsapp_contacts_load(p_contact_id uuid, p_for_update boolean)
returns public.whatsapp_contacts
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  if p_for_update then
    select * into v_c from public.whatsapp_contacts where id = p_contact_id for update;
  else
    select * into v_c from public.whatsapp_contacts where id = p_contact_id;
  end if;
  if not found or public.user_role_in_company(v_c.company_id) is null then
    raise exception 'Contato não encontrado.' using errcode = 'PT404';
  end if;
  return v_c;
end;
$$;

create function public.whatsapp_contact_json(c public.whatsapp_contacts)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'phone', c.phone_e164, 'contact_key', c.contact_key, 'notes', c.notes, 'source', c.source,
    'customer_id', c.customer_id,
    'customer_name', (select u.name from public.customers u where u.company_id = c.company_id and u.id = c.customer_id),
    'customer_active', (select u.is_active from public.customers u where u.company_id = c.company_id and u.id = c.customer_id),
    'archived_at', c.archived_at, 'created_at', c.created_at, 'updated_at', c.updated_at)
$$;

revoke execute on function public.whatsapp_contacts_assert_writer(uuid, boolean) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_contacts_load(uuid, boolean) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_contact_json(public.whatsapp_contacts) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Criar
-- ---------------------------------------------------------------------------
create function public.create_whatsapp_contact(p_company_id uuid, p_name text, p_phone text, p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_e164 text;
  v_row public.whatsapp_contacts;
  v_exist uuid;
  v_fields text[] := array['nome', 'telefone'];
begin
  perform public.whatsapp_contacts_assert_writer(p_company_id, false);
  if v_name = '' then
    raise exception 'Informe o nome do contato.' using errcode = 'PT400';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'O nome pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'As observações podem ter no máximo 1000 caracteres.' using errcode = 'PT400';
  end if;
  v_e164 := public.whatsapp_contact_normalize_phone(p_phone);
  if v_e164 is null then
    raise exception 'Telefone inválido. Informe o DDD (ex.: (44) 99999-8888) ou, para outro país, comece com + e o código do país.' using errcode = 'PT400';
  end if;

  insert into public.whatsapp_contacts (company_id, phone_e164, name, notes, created_by, updated_by)
  values (p_company_id, v_e164, v_name, v_notes, auth.uid(), auth.uid())
  on conflict (company_id, contact_key) where archived_at is null do nothing
  returning * into v_row;
  if not found then
    select c.id into v_exist from public.whatsapp_contacts c
     where c.company_id = p_company_id and c.contact_key = public.whatsapp_contact_key(v_e164, false) and c.archived_at is null;
    raise exception 'Já existe um contato ativo com este telefone.' using errcode = 'PT409', detail = coalesce(v_exist::text, '');
  end if;

  if v_notes is not null then v_fields := array_append(v_fields, 'observacoes'); end if;
  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id, new_value)
  values (p_company_id, v_row.id, 'created', auth.uid(), jsonb_build_object('campos', to_jsonb(v_fields), 'origem', 'manual'));

  return jsonb_build_object('ok', true, 'changed', true, 'contact', public.whatsapp_contact_json(v_row));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Editar (nome, telefone e observações juntos; observações vazias limpam)
-- ---------------------------------------------------------------------------
create function public.update_whatsapp_contact(p_contact_id uuid, p_name text, p_phone text, p_notes text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_e164 text;
  v_exist uuid;
  v_fields text[] := '{}';
  v_new public.whatsapp_contacts;
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, true);
  perform public.whatsapp_contacts_assert_writer(v_c.company_id, false);
  if v_c.archived_at is not null then
    raise exception 'Este contato está arquivado. Restaure-o para editar.' using errcode = 'PT409';
  end if;
  if v_name = '' then
    raise exception 'Informe o nome do contato.' using errcode = 'PT400';
  end if;
  if char_length(v_name) > 80 then
    raise exception 'O nome pode ter no máximo 80 caracteres.' using errcode = 'PT400';
  end if;
  if v_notes is not null and char_length(v_notes) > 1000 then
    raise exception 'As observações podem ter no máximo 1000 caracteres.' using errcode = 'PT400';
  end if;
  v_e164 := public.whatsapp_contact_normalize_phone(p_phone);
  if v_e164 is null then
    raise exception 'Telefone inválido. Informe o DDD (ex.: (44) 99999-8888) ou, para outro país, comece com + e o código do país.' using errcode = 'PT400';
  end if;

  if v_name is distinct from v_c.name then v_fields := array_append(v_fields, 'nome'); end if;
  if v_e164 is distinct from v_c.phone_e164 then v_fields := array_append(v_fields, 'telefone'); end if;
  if v_notes is distinct from v_c.notes then v_fields := array_append(v_fields, 'observacoes'); end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('ok', true, 'changed', false, 'contact', public.whatsapp_contact_json(v_c));
  end if;

  begin
    update public.whatsapp_contacts
       set name = v_name, phone_e164 = v_e164, notes = v_notes, updated_by = auth.uid()
     where id = v_c.id
    returning * into v_new;
  exception when unique_violation then
    select c.id into v_exist from public.whatsapp_contacts c
     where c.company_id = v_c.company_id and c.contact_key = public.whatsapp_contact_key(v_e164, false) and c.archived_at is null and c.id <> v_c.id;
    raise exception 'Já existe um contato ativo com este telefone.' using errcode = 'PT409', detail = coalesce(v_exist::text, '');
  end;

  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id, new_value)
  values (v_c.company_id, v_c.id, 'updated', auth.uid(), jsonb_build_object('campos', to_jsonb(v_fields)));

  return jsonb_build_object('ok', true, 'changed', true, 'contact', public.whatsapp_contact_json(v_new));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Detalhe (qualquer papel que lê o WhatsApp; inclui observações)
-- ---------------------------------------------------------------------------
create function public.get_whatsapp_contact(p_contact_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_role public.company_role;
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, false);
  v_role := public.whatsapp_assert_reader(v_c.company_id);   -- papel leitor + módulo (production/courier e empresa sem módulo ficam de fora)
  return jsonb_build_object(
    'contact', public.whatsapp_contact_json(v_c),
    'permissions', jsonb_build_object(
      'can_edit', v_role in ('owner', 'admin', 'attendant') and v_c.archived_at is null,
      'can_link_customer', v_role in ('owner', 'admin', 'attendant') and v_c.archived_at is null,
      'can_archive', v_role in ('owner', 'admin') and v_c.archived_at is null,
      'can_restore', v_role in ('owner', 'admin') and v_c.archived_at is not null));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Arquivar / restaurar (owner e admin; idempotentes)
-- ---------------------------------------------------------------------------
create function public.archive_whatsapp_contact(p_contact_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_new public.whatsapp_contacts;
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, true);
  perform public.whatsapp_contacts_assert_writer(v_c.company_id, true);
  if v_c.archived_at is not null then
    return jsonb_build_object('ok', true, 'changed', false, 'contact', public.whatsapp_contact_json(v_c));
  end if;
  update public.whatsapp_contacts set archived_at = now(), archived_by = auth.uid(), updated_by = auth.uid()
   where id = v_c.id returning * into v_new;
  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id)
  values (v_c.company_id, v_c.id, 'archived', auth.uid());
  return jsonb_build_object('ok', true, 'changed', true, 'contact', public.whatsapp_contact_json(v_new));
end;
$$;

create function public.restore_whatsapp_contact(p_contact_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_new public.whatsapp_contacts;
  v_exist uuid;
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, true);
  perform public.whatsapp_contacts_assert_writer(v_c.company_id, true);
  if v_c.archived_at is null then
    return jsonb_build_object('ok', true, 'changed', false, 'contact', public.whatsapp_contact_json(v_c));
  end if;
  begin
    update public.whatsapp_contacts set archived_at = null, archived_by = null, updated_by = auth.uid()
     where id = v_c.id returning * into v_new;
  exception when unique_violation then
    select c.id into v_exist from public.whatsapp_contacts c
     where c.company_id = v_c.company_id and c.contact_key = v_c.contact_key and c.archived_at is null and c.id <> v_c.id;
    raise exception 'Já existe um contato ativo com este telefone. Não é possível restaurar este.' using errcode = 'PT409', detail = coalesce(v_exist::text, '');
  end;
  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id)
  values (v_c.company_id, v_c.id, 'restored', auth.uid());
  return jsonb_build_object('ok', true, 'changed', true, 'contact', public.whatsapp_contact_json(v_new));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Vincular / desvincular cliente (existente, ATIVO e da mesma empresa; nunca cria cliente; não toca em conversas)
-- ---------------------------------------------------------------------------
create function public.set_whatsapp_contact_customer(p_contact_id uuid, p_customer_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.whatsapp_contacts;
  v_new public.whatsapp_contacts;
  v_active boolean;
begin
  v_c := public.whatsapp_contacts_load(p_contact_id, true);
  perform public.whatsapp_contacts_assert_writer(v_c.company_id, false);
  if v_c.archived_at is not null then
    raise exception 'Este contato está arquivado. Restaure-o para vincular a um cliente.' using errcode = 'PT409';
  end if;
  if p_customer_id is not null then
    -- inexistente e de outra empresa dão a MESMA resposta (nada de outra empresa é revelado)
    select u.is_active into v_active from public.customers u where u.company_id = v_c.company_id and u.id = p_customer_id;
    if not found then
      raise exception 'Cliente não encontrado.' using errcode = 'PT404';
    end if;
    if not v_active then
      raise exception 'Este cliente está inativo.' using errcode = 'PT409';
    end if;
  end if;
  if v_c.customer_id is not distinct from p_customer_id then
    return jsonb_build_object('ok', true, 'changed', false, 'contact', public.whatsapp_contact_json(v_c));
  end if;
  update public.whatsapp_contacts set customer_id = p_customer_id, updated_by = auth.uid()
   where id = v_c.id returning * into v_new;
  insert into public.whatsapp_contact_events (company_id, contact_id, event_type, actor_user_id, old_value, new_value)
  values (v_c.company_id, v_c.id, case when p_customer_id is null then 'customer_unlinked' else 'customer_linked' end, auth.uid(),
          jsonb_build_object('customer_id', v_c.customer_id), jsonb_build_object('customer_id', p_customer_id));
  return jsonb_build_object('ok', true, 'changed', true, 'contact', public.whatsapp_contact_json(v_new));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) ACL: só authenticated executa as 6 públicas
-- ---------------------------------------------------------------------------
revoke execute on function public.create_whatsapp_contact(uuid, text, text, text) from public, anon, service_role;
revoke execute on function public.update_whatsapp_contact(uuid, text, text, text) from public, anon, service_role;
revoke execute on function public.get_whatsapp_contact(uuid) from public, anon, service_role;
revoke execute on function public.archive_whatsapp_contact(uuid) from public, anon, service_role;
revoke execute on function public.restore_whatsapp_contact(uuid) from public, anon, service_role;
revoke execute on function public.set_whatsapp_contact_customer(uuid, uuid) from public, anon, service_role;
grant execute on function public.create_whatsapp_contact(uuid, text, text, text) to authenticated;
grant execute on function public.update_whatsapp_contact(uuid, text, text, text) to authenticated;
grant execute on function public.get_whatsapp_contact(uuid) to authenticated;
grant execute on function public.archive_whatsapp_contact(uuid) to authenticated;
grant execute on function public.restore_whatsapp_contact(uuid) to authenticated;
grant execute on function public.set_whatsapp_contact_customer(uuid, uuid) to authenticated;
