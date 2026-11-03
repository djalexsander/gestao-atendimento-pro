-- Reconhecimento automático de cliente pelo número do WhatsApp + endereço cadastrado como SUGESTÃO no pedido (Fase 1: só banco).
--
-- ATIVAÇÃO CONTROLADA: tudo o que muda o ATENDIMENTO (vínculo automático, saudação personalizada, endereço salvo) só vale para empresas com
-- company_whatsapp_ai_settings.customer_recognition_enabled = true. O padrão é FALSE para todas as empresas (inclusive as que já usam a IA):
-- com a flag desligada o atendimento é idêntico ao de antes desta migration. Só o Admin Master liga/desliga (master_whatsapp_set_customer_recognition),
-- com trilha de auditoria; vale na hora, sem deploy. Desligar pode também desfazer os vínculos AUTOMÁTICOS (nunca os manuais).
--
-- Regras (decididas pelo dono do produto):
--   * o vínculo é DETERMINÍSTICO: núcleo do telefone (whatsapp_phone_core) + company_id da conversa + cliente ATIVO. Nenhuma IA decide;
--   * exatamente 1 cliente compatível => vincula. 0 => nada. 2 ou mais => NÃO vincula, não compartilha nenhum dado, registra o fato 1 vez;
--   * nunca sobrescreve vínculo existente (humano ou automático) e nunca religa uma conversa que um humano DESVINCULOU;
--   * nunca cria nem altera cliente / endereço cadastrado;
--   * origem do vínculo auditável: whatsapp_conversations.customer_link_source ('manual' | 'auto_phone') + evento customer_linked
--     (actor nulo, new_value.source = 'auto_phone');
--   * idempotente e seguro sob concorrência: a conversa é travada FOR UPDATE; mensagem repetida (webhook duplicado) nem chega à função.
--
-- Endereço salvo no pedido (só Delivery ativo, só quando a conversa tem cliente vinculado e ativo). Máquina de estados no rascunho:
--   none --offer--> offered --accept--> confirming --use--> accepted
--                       \-------decline-------/ \--decline--> rejected
--   * 'offered'    : o cliente foi perguntado SEM ver o endereço ("Encontrei um endereço cadastrado... deseja usá-lo?");
--   * 'confirming' : o cliente disse sim; SÓ AGORA o endereço completo é devolvido ao worker para a confirmação final;
--   * 'accepted'   : confirmação final; o endereço foi copiado para o rascunho pelo MESMO caminho de validação do endereço digitado
--                    (whatsapp_order_set_address: delivery_clean_address, zona, taxa, recálculo);
--   * 'rejected'   : recusou, ou digitou outro endereço (trigger): vale só para aquele pedido; o cadastro NUNCA é alterado.
--   * várias opções: sugere o endereço ativo atualizado mais recentemente (updated_at desc, created_at desc, id desc).
-- Saudação da 1ª interação (seção 9): whatsapp_ai_auto_intro passa a devolver também as peças da saudação personalizada
-- (período do dia no fuso da empresa + nome cadastrado do cliente vinculado), tudo decidido no banco, fora do LLM.
-- Nada daqui altera estoque, caixa, produção, retirada ou o motor de pedidos. O endereço do pedido segue como snapshot.
-- Ajustes em funções existentes por substituição exata da definição viva (mesmo método da 20261103010000): se o trecho não ocorrer
-- exatamente uma vez, a migration falha inteira.

-- ---------------------------------------------------------------------------
-- 1) Origem do vínculo + eventos
-- ---------------------------------------------------------------------------
alter table public.whatsapp_conversations
  add column customer_link_source text
    constraint whatsapp_conversations_link_source_check check (customer_link_source is null or customer_link_source in ('manual', 'auto_phone')),
  add constraint whatsapp_conversations_link_source_customer_check check (customer_link_source is null or customer_id is not null);

comment on column public.whatsapp_conversations.customer_link_source is
  'Origem do vínculo customer_id: manual (atendente) ou auto_phone (telefone normalizado, único e ativo). Nulo = sem vínculo.';

-- vínculos que já existem foram feitos por pessoas
update public.whatsapp_conversations set customer_link_source = 'manual' where customer_id is not null and customer_link_source is null;

alter table public.whatsapp_conversation_events drop constraint whatsapp_conversation_events_type_check;
alter table public.whatsapp_conversation_events add constraint whatsapp_conversation_events_type_check check (event_type in (
  'created', 'assigned', 'unassigned', 'status_changed', 'customer_linked', 'customer_unlinked', 'closed', 'reopened', 'order_linked',
  'ai_paused', 'ai_resumed', 'ai_handoff', 'deleted', 'customer_match_ambiguous'));

alter table public.whatsapp_order_draft_events drop constraint whatsapp_order_draft_events_type_check;
alter table public.whatsapp_order_draft_events add constraint whatsapp_order_draft_events_type_check check (event_type in (
  'draft_created', 'item_added', 'item_removed', 'item_changed', 'modifier_set', 'fulfillment_set', 'contact_set', 'address_set',
  'address_validated', 'payment_set', 'summary_sent', 'confirm_received', 'revalidated', 'price_changed', 'unavailable',
  'order_created', 'handoff', 'cancelled', 'expired', 'failed',
  'customer_synced', 'saved_address_offered', 'saved_address_accepted', 'saved_address_declined', 'saved_address_used'));

-- Flag por empresa (padrão DESLIGADA). Sem linha de configuração da IA = desligada.
alter table public.company_whatsapp_ai_settings
  add column customer_recognition_enabled boolean not null default false;
comment on column public.company_whatsapp_ai_settings.customer_recognition_enabled is
  'Reconhecimento automático de clientes pelo telefone + saudação personalizada + endereço cadastrado sugerido (ativação controlada). Padrão false. Só o Admin Master altera (master_whatsapp_set_customer_recognition).';

create function public.whatsapp_customer_recognition_on(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select s.customer_recognition_enabled from public.company_whatsapp_ai_settings s where s.company_id = p_company_id), false)
$$;
revoke execute on function public.whatsapp_customer_recognition_on(uuid) from public, anon, authenticated, service_role;

create table public.whatsapp_feature_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  feature text not null constraint whatsapp_feature_events_feature check (feature in ('customer_recognition')),
  enabled boolean not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  note text constraint whatsapp_feature_events_note_length check (note is null or char_length(note) <= 500),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index whatsapp_feature_events_company_idx on public.whatsapp_feature_events (company_id, created_at desc);
alter table public.whatsapp_feature_events enable row level security;
revoke all on public.whatsapp_feature_events from public, anon, authenticated;
grant all on public.whatsapp_feature_events to service_role;
create trigger whatsapp_feature_events_immutable
  before update or delete on public.whatsapp_feature_events
  for each row execute function public.whatsapp_guard_append_only();
comment on table public.whatsapp_feature_events is 'Trilha de auditoria da ativação controlada de recursos do WhatsApp (quem ligou/desligou e quando). Só acréscimo.';

-- ---------------------------------------------------------------------------
-- 2) Vínculo automático (interno: só a ingestão chama)
-- ---------------------------------------------------------------------------
create function public.whatsapp_auto_link_customer(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.whatsapp_conversations;
  v_core text;
  v_ids uuid[];
  v_n integer;
begin
  -- trava a conversa: duas ingestões simultâneas do mesmo número se serializam aqui
  select * into v_conv from public.whatsapp_conversations where id = p_conversation_id and deleted_at is null for update;
  if not found then
    return jsonb_build_object('result', 'no_conversation');
  end if;
  if not public.whatsapp_customer_recognition_on(v_conv.company_id) then
    return jsonb_build_object('result', 'disabled');   -- ativação controlada: desligada = nada muda
  end if;
  if v_conv.customer_id is not null then
    return jsonb_build_object('result', 'already_linked');
  end if;
  -- um HUMANO desvinculou: a decisão dele não é desfeita automaticamente (a desvinculação automática do Admin Master não conta)
  if exists (select 1 from public.whatsapp_conversation_events e
              where e.company_id = v_conv.company_id and e.conversation_id = v_conv.id and e.event_type = 'customer_unlinked' and e.actor_user_id is not null) then
    return jsonb_build_object('result', 'human_unlinked');
  end if;

  v_core := public.whatsapp_phone_core(v_conv.contact_phone);
  if v_core is null or char_length(v_core) < 10 then
    return jsonb_build_object('result', 'no_phone');
  end if;

  select array_agg(c.id order by c.id) into v_ids
    from public.customers c
   where c.company_id = v_conv.company_id
     and c.is_active
     and (public.whatsapp_phone_core(c.whatsapp) = v_core or public.whatsapp_phone_core(c.phone) = v_core);
  v_n := coalesce(cardinality(v_ids), 0);

  if v_n = 0 then
    return jsonb_build_object('result', 'no_match');
  end if;
  if v_n > 1 then
    -- ambíguo: nada é vinculado nem exposto; o fato é registrado uma única vez (sem ids de clientes)
    if not exists (select 1 from public.whatsapp_conversation_events e
                    where e.company_id = v_conv.company_id and e.conversation_id = v_conv.id and e.event_type = 'customer_match_ambiguous') then
      insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, new_value)
      values (v_conv.company_id, v_conv.id, 'customer_match_ambiguous', jsonb_build_object('source', 'auto_phone', 'candidates', v_n));
    end if;
    return jsonb_build_object('result', 'ambiguous');
  end if;

  update public.whatsapp_conversations
     set customer_id = v_ids[1], customer_link_source = 'auto_phone'
   where id = v_conv.id and customer_id is null;
  insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
  values (v_conv.company_id, v_conv.id, 'customer_linked', null,
          jsonb_build_object('customer_id', null), jsonb_build_object('customer_id', v_ids[1], 'source', 'auto_phone'));
  return jsonb_build_object('result', 'linked');
end;
$$;

revoke execute on function public.whatsapp_auto_link_customer(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Ajustes em funções existentes (substituição exata)
-- ---------------------------------------------------------------------------
create function pg_temp.patch_wa_customer_link_fn(p_name text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
  v_new text;
begin
  select p.oid into v_oid from pg_proc p where p.proname = p_name and p.pronamespace = 'public'::regnamespace;
  if v_oid is null then
    raise exception 'patch_fn: função % não encontrada', p_name;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_name;
  end if;
  v_new := replace(v_def, p_from, p_to);
  execute v_new;
end;
$$;

-- 3.1) Ingestão: depois de gravar a mensagem (duplicadas já retornaram antes), tenta o vínculo. Falha do vínculo NUNCA derruba a mensagem.
select pg_temp.patch_wa_customer_link_fn('whatsapp_ingest_message',
  $f$  select (status = 'closed') into v_was_closed from public.whatsapp_conversations where id = v_conv_id;$f$,
  $f$  begin
    perform public.whatsapp_auto_link_customer(v_conv_id);
  exception when others then
    null;
  end;

  select (status = 'closed') into v_was_closed from public.whatsapp_conversations where id = v_conv_id;$f$);

-- 3.2) Vínculo feito por atendente grava a origem 'manual' (desvincular limpa a origem)
select pg_temp.patch_wa_customer_link_fn('link_whatsapp_conversation_customer',
  $f$  update public.whatsapp_conversations set customer_id = p_customer_id where id = v_conv.id;$f$,
  $f$  update public.whatsapp_conversations
     set customer_id = p_customer_id, customer_link_source = case when p_customer_id is null then null else 'manual' end
   where id = v_conv.id;$f$);

-- ---------------------------------------------------------------------------
-- 4) Estado da sugestão no rascunho
-- ---------------------------------------------------------------------------
alter table public.whatsapp_order_drafts
  add column address_offer_status text not null default 'none'
    constraint whatsapp_order_drafts_offer_status_check check (address_offer_status in ('none', 'offered', 'confirming', 'accepted', 'rejected')),
  add column address_offer_address_id uuid,
  add column address_offer_shown_at timestamptz,
  add constraint whatsapp_order_drafts_offer_address_fkey
    foreign key (company_id, address_offer_address_id) references public.customer_addresses (company_id, id),
  add constraint whatsapp_order_drafts_offer_address_check
    check ((address_offer_status in ('offered', 'confirming', 'accepted')) = (address_offer_address_id is not null)),
  add constraint whatsapp_order_drafts_offer_shown_check
    check (address_offer_status <> 'confirming' or address_offer_shown_at is not null);

-- digitar outro endereço enquanto há sugestão aberta a recusa (vale só para o pedido); estado terminal limpa a sugestão
create function public.guard_whatsapp_order_draft_offer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status in ('confirmed', 'cancelled', 'expired', 'failed') then
    new.address_offer_status := 'none'; new.address_offer_address_id := null; new.address_offer_shown_at := null;
    return new;
  end if;
  if new.address_offer_status in ('offered', 'confirming')
     and (new.addr_street, new.addr_number, new.addr_complement, new.addr_neighborhood, new.addr_city, new.addr_state, new.addr_cep, new.addr_reference)
         is distinct from
         (old.addr_street, old.addr_number, old.addr_complement, old.addr_neighborhood, old.addr_city, old.addr_state, old.addr_cep, old.addr_reference)
     and coalesce(current_setting('app.wa_saved_address_use', true), '') <> 'on' then
    new.address_offer_status := 'rejected'; new.address_offer_address_id := null; new.address_offer_shown_at := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_order_draft_offer() from public, anon, authenticated;

create trigger whatsapp_order_drafts_offer_guard
  before update on public.whatsapp_order_drafts
  for each row execute function public.guard_whatsapp_order_draft_offer();

-- o estado devolvido ao worker passa a informar em que ponto está a sugestão (nunca o endereço)
select pg_temp.patch_wa_customer_link_fn('whatsapp_order_state',
  $f$'customer_linked', d.customer_id is not null, 'notes', d.notes,$f$,
  $f$'customer_linked', d.customer_id is not null, 'address_offer', d.address_offer_status, 'notes', d.notes,$f$);

-- ---------------------------------------------------------------------------
-- 5) Leituras controladas (service_role, sempre por job ativo)
-- ---------------------------------------------------------------------------
-- Endereço ativo mais recentemente atualizado de um cliente ATIVO da empresa (linha vazia = não há).
create function public.whatsapp_saved_address_pick(p_company_id uuid, p_customer_id uuid)
returns public.customer_addresses
language sql
stable
security definer
set search_path = public
as $$
  select a.*
    from public.customer_addresses a
    join public.customers c on c.company_id = a.company_id and c.id = a.customer_id and c.is_active
   where a.company_id = p_company_id and a.customer_id = p_customer_id and a.is_active
   order by a.updated_at desc, a.created_at desc, a.id desc
   limit 1
$$;
revoke execute on function public.whatsapp_saved_address_pick(uuid, uuid) from public, anon, authenticated, service_role;

-- Cliente vinculado à conversa do job: SÓ primeiro nome e se há endereço salvo. Sem endereço, telefone, documento ou ids.
create function public.whatsapp_customer_context(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id, null);
  v_cust uuid;
  v_name text;
  v_addr public.customer_addresses;
  v_src text;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  if not public.whatsapp_customer_recognition_on((v_ctx ->> 'company_id')::uuid) then
    return jsonb_build_object('result', 'ok', 'linked', false, 'disabled', true);
  end if;
  v_cust := nullif(v_ctx ->> 'customer_id', '')::uuid;
  if v_cust is null then
    return jsonb_build_object('result', 'ok', 'linked', false);
  end if;
  select nullif(split_part(btrim(c.name), ' ', 1), '') into v_name
    from public.customers c where c.company_id = (v_ctx ->> 'company_id')::uuid and c.id = v_cust and c.is_active;
  select customer_link_source into v_src from public.whatsapp_conversations where id = (v_ctx ->> 'conversation_id')::uuid;
  v_addr := public.whatsapp_saved_address_pick((v_ctx ->> 'company_id')::uuid, v_cust);
  return jsonb_build_object('result', 'ok', 'linked', true, 'first_name', v_name, 'link_source', v_src,
                            'has_saved_address', v_addr.id is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Sugestão do endereço salvo: offer / accept / decline
-- ---------------------------------------------------------------------------
create function public.whatsapp_order_saved_address_offer(p_job_id uuid, p_action text, p_expected_latest uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb;
  v_company uuid;
  v_cust uuid;
  v_d public.whatsapp_order_drafts;
  v_a public.customer_addresses;
begin
  if p_action is null or p_action not in ('offer', 'accept', 'decline') then
    return jsonb_build_object('result', 'invalid', 'reason', 'action');
  end if;
  v_ctx := public.whatsapp_order_ctx(p_job_id, p_expected_latest);
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  if not public.whatsapp_customer_recognition_on(v_company) then
    return jsonb_build_object('result', 'disabled');   -- ativação controlada: o atendimento segue como sempre
  end if;
  v_cust := nullif(v_ctx ->> 'customer_id', '')::uuid;
  v_d := public.whatsapp_order_open_draft(v_company, (v_ctx ->> 'conversation_id')::uuid);
  if v_d.id is null then
    return jsonb_build_object('result', 'invalid', 'reason', 'no_draft');
  end if;
  if v_d.fulfillment is distinct from 'delivery' then
    return jsonb_build_object('result', 'invalid', 'reason', 'not_delivery');
  end if;
  if not public.company_has_module(v_company, 'delivery') then
    return jsonb_build_object('result', 'invalid', 'reason', 'module_inactive');
  end if;
  if v_cust is null then
    return jsonb_build_object('result', 'no_customer');
  end if;

  -- o cliente da conversa mudou (ou o rascunho nasceu antes do vínculo): o rascunho acompanha, e qualquer sugestão aberta cai
  if v_d.customer_id is distinct from v_cust then
    update public.whatsapp_order_drafts
       set customer_id = v_cust,
           address_offer_status = case when address_offer_status = 'accepted' then address_offer_status else 'none' end,
           address_offer_address_id = case when address_offer_status = 'accepted' then address_offer_address_id end,
           address_offer_shown_at = null
     where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'customer_synced', '{}'::jsonb);
    select * into v_d from public.whatsapp_order_drafts where id = v_d.id;
  end if;

  if p_action = 'offer' then
    if v_d.address_offer_status = 'accepted' then
      return jsonb_build_object('result', 'already_used', 'state', public.whatsapp_order_state(v_d.id));
    elsif v_d.address_offer_status in ('offered', 'confirming') then
      return jsonb_build_object('result', 'already_offered', 'state', public.whatsapp_order_state(v_d.id));
    elsif v_d.address_offer_status = 'rejected' then
      return jsonb_build_object('result', 'already_declined', 'state', public.whatsapp_order_state(v_d.id));
    end if;
    if v_d.addr_street is not null or v_d.addr_neighborhood is not null or v_d.addr_city is not null then
      return jsonb_build_object('result', 'address_already_set', 'state', public.whatsapp_order_state(v_d.id));
    end if;
    v_a := public.whatsapp_saved_address_pick(v_company, v_cust);
    if v_a.id is null then
      return jsonb_build_object('result', 'no_saved_address', 'state', public.whatsapp_order_state(v_d.id));
    end if;
    update public.whatsapp_order_drafts set address_offer_status = 'offered', address_offer_address_id = v_a.id where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_offered', '{}'::jsonb);
    return jsonb_build_object('result', 'offered', 'state', public.whatsapp_order_state(v_d.id));  -- nenhum dado do endereço
  end if;

  if p_action = 'accept' then
    if v_d.address_offer_status = 'accepted' then
      return jsonb_build_object('result', 'already_used', 'state', public.whatsapp_order_state(v_d.id));
    elsif v_d.address_offer_status not in ('offered', 'confirming') then
      return jsonb_build_object('result', 'not_offered', 'state', public.whatsapp_order_state(v_d.id));
    end if;
    -- escolhe de novo (o cadastro pode ter mudado desde a pergunta); só agora o endereço sai do banco
    v_a := public.whatsapp_saved_address_pick(v_company, v_cust);
    if v_a.id is null then
      update public.whatsapp_order_drafts set address_offer_status = 'none', address_offer_address_id = null, address_offer_shown_at = null where id = v_d.id;
      return jsonb_build_object('result', 'no_saved_address', 'state', public.whatsapp_order_state(v_d.id));
    end if;
    update public.whatsapp_order_drafts
       set address_offer_status = 'confirming', address_offer_address_id = v_a.id, address_offer_shown_at = now(),
           last_customer_activity_at = now(), expires_at = now() + interval '60 minutes'
     where id = v_d.id;
    -- repetir o "sim" só reapresenta o endereço: o evento é gravado uma vez, na transição offered -> confirming
    if v_d.address_offer_status = 'offered' then
      perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_accepted', '{}'::jsonb);
    end if;
    return jsonb_build_object('result', 'confirm_address',
      'address', jsonb_build_object('street', v_a.street, 'number', v_a.number, 'complement', v_a.complement,
                                    'neighborhood', v_a.neighborhood, 'city', v_a.city, 'state', v_a.state, 'cep', v_a.cep, 'reference', v_a.reference),
      'display', v_a.street || coalesce(', ' || v_a.number, '') || coalesce(' - ' || v_a.complement, '') || ', ' || v_a.neighborhood
                 || ', ' || v_a.city || '/' || v_a.state,
      'state', public.whatsapp_order_state(v_d.id));
  end if;

  -- decline
  if v_d.address_offer_status = 'rejected' then
    return jsonb_build_object('result', 'declined', 'state', public.whatsapp_order_state(v_d.id));
  elsif v_d.address_offer_status = 'accepted' then
    return jsonb_build_object('result', 'already_used', 'state', public.whatsapp_order_state(v_d.id));
  elsif v_d.address_offer_status = 'none' then
    return jsonb_build_object('result', 'not_offered', 'state', public.whatsapp_order_state(v_d.id));
  end if;
  update public.whatsapp_order_drafts
     set address_offer_status = 'rejected', address_offer_address_id = null, address_offer_shown_at = null,
         last_customer_activity_at = now(), expires_at = now() + interval '60 minutes'
   where id = v_d.id;
  perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_declined', '{}'::jsonb);
  return jsonb_build_object('result', 'declined', 'state', public.whatsapp_order_state(v_d.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Usar o endereço cadastrado (confirmação final do cliente)
-- ---------------------------------------------------------------------------
create function public.whatsapp_order_use_saved_address(p_job_id uuid, p_expected_latest uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb;
  v_company uuid;
  v_cust uuid;
  v_d public.whatsapp_order_drafts;
  v_a public.customer_addresses;
  v_res jsonb;
begin
  v_ctx := public.whatsapp_order_ctx(p_job_id, p_expected_latest);
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  if not public.whatsapp_customer_recognition_on(v_company) then
    return jsonb_build_object('result', 'disabled');
  end if;
  v_cust := nullif(v_ctx ->> 'customer_id', '')::uuid;
  v_d := public.whatsapp_order_open_draft(v_company, (v_ctx ->> 'conversation_id')::uuid);
  if v_d.id is null then
    return jsonb_build_object('result', 'invalid', 'reason', 'no_draft');
  end if;
  if v_d.fulfillment is distinct from 'delivery' then
    return jsonb_build_object('result', 'invalid', 'reason', 'not_delivery');
  end if;
  if not public.company_has_module(v_company, 'delivery') then
    return jsonb_build_object('result', 'invalid', 'reason', 'module_inactive');
  end if;
  if v_cust is null or v_d.customer_id is distinct from v_cust then
    return jsonb_build_object('result', 'no_customer');
  end if;
  if v_d.address_offer_status = 'accepted' then
    return jsonb_build_object('result', 'already_used', 'state', public.whatsapp_order_state(v_d.id));
  end if;
  -- só depois de "sim" à pergunta inicial E de o endereço ter sido mostrado ao cliente
  if v_d.address_offer_status is distinct from 'confirming' then
    return jsonb_build_object('result', 'not_confirming', 'state', public.whatsapp_order_state(v_d.id));
  end if;

  -- usa exatamente o endereço que o cliente viu: ainda ativo, do mesmo cliente/empresa e sem alteração depois de mostrado
  select * into v_a from public.customer_addresses a
   where a.company_id = v_company and a.customer_id = v_cust and a.id = v_d.address_offer_address_id
     and a.is_active and a.updated_at <= v_d.address_offer_shown_at
     and exists (select 1 from public.customers c where c.company_id = a.company_id and c.id = a.customer_id and c.is_active);
  if not found then
    update public.whatsapp_order_drafts set address_offer_status = 'rejected', address_offer_address_id = null, address_offer_shown_at = null where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_declined', jsonb_build_object('reason', 'address_changed'));
    return jsonb_build_object('result', 'address_unavailable', 'state', public.whatsapp_order_state(v_d.id));
  end if;

  -- mesmo caminho do endereço digitado: validação oficial, zona, taxa e recálculo
  perform set_config('app.wa_saved_address_use', 'on', true);
  v_res := public.whatsapp_order_set_address(p_job_id,
    jsonb_build_object('street', v_a.street, 'number', v_a.number, 'complement', v_a.complement, 'neighborhood', v_a.neighborhood,
                       'city', v_a.city, 'state', v_a.state, 'cep', v_a.cep, 'reference', v_a.reference),
    p_expected_latest, null);
  perform set_config('app.wa_saved_address_use', '', true);

  if v_res ->> 'result' = 'blocked' then
    return v_res;
  end if;
  if v_res ->> 'result' <> 'ok' then
    update public.whatsapp_order_drafts set address_offer_status = 'rejected', address_offer_address_id = null, address_offer_shown_at = null where id = v_d.id;
    perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_declined', jsonb_build_object('reason', coalesce(v_res ->> 'reason', 'invalid')));
    return jsonb_build_object('result', 'address_rejected', 'reason', v_res ->> 'reason', 'state', public.whatsapp_order_state(v_d.id));
  end if;

  update public.whatsapp_order_drafts
     set address_offer_status = 'accepted', address_offer_address_id = v_a.id, address_offer_shown_at = null
   where id = v_d.id;
  perform public.whatsapp_order_event(v_company, v_d.id, 'saved_address_used', jsonb_build_object('address_status', v_res ->> 'address_status'));
  return jsonb_build_object('result', 'used', 'address_status', v_res ->> 'address_status', 'zone_candidates', v_res -> 'zone_candidates', 'state', public.whatsapp_order_state(v_d.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Permissões: só o worker (service_role)
-- ---------------------------------------------------------------------------
revoke execute on function public.whatsapp_customer_context(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_order_saved_address_offer(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_order_use_saved_address(uuid, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_customer_context(uuid) to service_role;
grant execute on function public.whatsapp_order_saved_address_offer(uuid, text, uuid) to service_role;
grant execute on function public.whatsapp_order_use_saved_address(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9) Saudação personalizada na 1ª interação (estende whatsapp_ai_auto_intro; NÃO cria fluxo paralelo)
-- ---------------------------------------------------------------------------
-- A decisão de "quem é o cliente" e "qual nome usar" é 100% do banco e fica fora do LLM e fora de qualquer prompt:
--   * só o cliente VINCULADO à conversa (vínculo único, ativo, da própria empresa) entra; ambíguo/sem cadastro/inativo => saudação genérica;
--   * o nome do perfil do WhatsApp (contact_display_name) NUNCA é usado como identificação;
--   * nome = nome CADASTRADO, preservando formas como "DJ Alex" (até 2 palavras: inteiro; 3+ palavras: sigla maiúscula de 2-3 letras + próximo
--     nome, senão só o primeiro nome); sem caracteres de formatação do WhatsApp (* _ ~ `) nem emojis; cliente PJ => sem nome;
--   * período do dia pelo fuso da empresa (company_business_profile.timezone; senão o do expediente da IA; senão America/Sao_Paulo):
--     05:00-11:59 Bom dia, 12:00-17:59 Boa tarde, 18:00-04:59 Boa noite. Relógio = business_now() (o mesmo substituível nos testes);
--   * só na 1ª saída da conversa (first=true; mensagem repetida/lote da mesma ida não repete) e nunca com pedido em andamento;
--   * a saudação não traz endereço, telefone nem qualquer outro dado do cadastro.
-- O texto final é composto pela Edge (próxima fase) com estas peças prontas; as chaves antigas (first, intro) continuam iguais.
create function public.whatsapp_greeting_name(p_name text, p_type text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_n text;
  v_w text[];
begin
  if p_type is distinct from 'person' then
    return null;
  end if;
  v_n := regexp_replace(coalesce(p_name, ''), '[[:cntrl:]*_~`<>@#\/|{}\[\]()%$&=+:;!?"]|[\U0001F000-\U0001FAFF]|[\u2600-\u27BF]', '', 'g');
  v_n := btrim(regexp_replace(v_n, '\s+', ' ', 'g'));
  if v_n = '' then
    return null;
  end if;
  v_w := string_to_array(v_n, ' ');
  if cardinality(v_w) <= 2 then
    return left(v_n, 40);
  elsif v_w[1] ~ '^[A-Z]{2,3}$' then
    return left(v_w[1] || ' ' || v_w[2], 40);
  end if;
  return left(v_w[1], 40);
end;
$$;

create function public.whatsapp_time_greeting(p_at timestamptz, p_timezone text)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_tz text := case when exists (select 1 from pg_timezone_names z where z.name = p_timezone) then p_timezone else 'America/Sao_Paulo' end;
  v_h integer := extract(hour from (p_at at time zone v_tz))::integer;
begin
  return case when v_h between 5 and 11 then 'Bom dia' when v_h between 12 and 17 then 'Boa tarde' else 'Boa noite' end;
end;
$$;

revoke execute on function public.whatsapp_greeting_name(text, text) from public, anon, authenticated, service_role;
revoke execute on function public.whatsapp_time_greeting(timestamptz, text) from public, anon, authenticated, service_role;

create or replace function public.whatsapp_ai_auto_intro(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_s public.company_whatsapp_ai_settings;
  v_biz text;
  v_first boolean;
  v_identity text;
  v_tz text;
  v_cust public.customers;
  v_conv_customer uuid;
  v_name text;
  v_known boolean := false;
  v_time text;
  v_busy boolean;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('first', false, 'intro', null);
  end if;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_job.company_id;
  select coalesce(nullif(btrim(v_s.business_name), ''), c.name) into v_biz from public.companies c where c.id = v_job.company_id;

  select not exists (
    select 1 from public.whatsapp_messages m
     where m.company_id = v_job.company_id and m.conversation_id = v_job.conversation_id
       and m.direction = 'outbound' and m.status <> 'failed' and m.ai_job_id is distinct from v_job.id
  ) into v_first;

  v_identity := case
    when nullif(v_s.ai_display_name, '') is not null then 'Eu sou a ' || v_s.ai_display_name || ', assistente virtual da ' || v_biz || '.'
    else 'Sou a Assistente Virtual da ' || v_biz || '.'
  end;

  -- pedido em andamento: nunca se interrompe com boas-vindas
  v_busy := exists (select 1 from public.whatsapp_order_drafts d
                     where d.company_id = v_job.company_id and d.conversation_id = v_job.conversation_id
                       and d.status in ('collecting', 'awaiting_confirmation'));

  -- sem a flag (padrão) ou fora da 1ª interação/com pedido em andamento: devolve EXATAMENTE o formato de antes desta migration
  if not v_first or v_busy or not public.whatsapp_customer_recognition_on(v_job.company_id) then
    return jsonb_build_object('first', v_first, 'intro', 'Olá! ' || v_identity);
  end if;

  -- cliente: SÓ o vínculo da conversa (único e ativo, da própria empresa). Nunca o nome do perfil do WhatsApp.
  select c.customer_id into v_conv_customer from public.whatsapp_conversations c
   where c.id = v_job.conversation_id and c.company_id = v_job.company_id and c.deleted_at is null;
  if v_conv_customer is not null then
    select * into v_cust from public.customers cu
     where cu.company_id = v_job.company_id and cu.id = v_conv_customer and cu.is_active;
    if found then
      v_known := true;
      v_name := public.whatsapp_greeting_name(v_cust.name, v_cust.customer_type);
    end if;
  end if;

  select coalesce(
           (select p.timezone from public.company_business_profile p where p.company_id = v_job.company_id),
           v_s.business_schedule ->> 'timezone',
           'America/Sao_Paulo') into v_tz;
  v_time := public.whatsapp_time_greeting(public.business_now(), v_tz);

  return jsonb_build_object(
    'first', true,
    'intro', 'Olá! ' || v_identity,
    'identity', v_identity,
    'time_greeting', v_time,
    'customer_known', v_known,
    'customer_name', v_name,
    'greeting', v_time || case when v_name is not null then ', ' || v_name else '' end || '! 😊',
    'welcome', case when v_known then 'Seja bem-vindo de volta!' else 'Seja bem-vindo!' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) Ativação controlada (SÓ Admin Master)
-- ---------------------------------------------------------------------------
-- Liga/desliga o reconhecimento de clientes + saudação + endereço salvo para UMA empresa, na hora (sem deploy). Exige a configuração da IA da
-- empresa (a flag mora nela). Desligar com p_clear_auto_links => desfaz só os vínculos AUTOMÁTICOS (customer_link_source = 'auto_phone'; os manuais
-- ficam) e zera sugestões de endereço abertas. Tudo auditado em whatsapp_feature_events; idempotente.
create function public.master_whatsapp_set_customer_recognition(
  p_company_id uuid, p_enabled boolean, p_note text default null, p_clear_auto_links boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_before boolean;
  v_cleared integer := 0;
  v_offers integer := 0;
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 500);
begin
  perform public.assert_master_admin();
  v_actor := auth.uid();
  if p_company_id is null or p_enabled is null then
    raise exception 'Parâmetros inválidos.' using errcode = 'PT400';
  end if;
  if not exists (select 1 from public.companies where id = p_company_id) then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wa_recognition:' || p_company_id::text, 0));
  select customer_recognition_enabled into v_before from public.company_whatsapp_ai_settings where company_id = p_company_id for update;
  if not found then
    raise exception 'Esta empresa ainda não configurou a IA do WhatsApp.' using errcode = 'PT409';
  end if;

  update public.company_whatsapp_ai_settings set customer_recognition_enabled = p_enabled where company_id = p_company_id and customer_recognition_enabled is distinct from p_enabled;

  if not p_enabled then
    update public.whatsapp_order_drafts
       set address_offer_status = 'none', address_offer_address_id = null, address_offer_shown_at = null
     where company_id = p_company_id and status in ('collecting', 'awaiting_confirmation') and address_offer_status in ('offered', 'confirming');
    get diagnostics v_offers = row_count;
    if coalesce(p_clear_auto_links, false) then
      with c as (
        update public.whatsapp_conversations set customer_id = null, customer_link_source = null
         where company_id = p_company_id and customer_link_source = 'auto_phone' and deleted_at is null
         returning id, company_id
      )
      insert into public.whatsapp_conversation_events (company_id, conversation_id, event_type, actor_user_id, old_value, new_value)
      select company_id, id, 'customer_unlinked', null, jsonb_build_object('source', 'auto_phone'), jsonb_build_object('customer_id', null, 'reason', 'recognition_disabled') from c;
      get diagnostics v_cleared = row_count;
    end if;
  end if;

  if v_before is distinct from p_enabled or v_cleared > 0 then
    insert into public.whatsapp_feature_events (company_id, feature, enabled, actor_user_id, note, detail)
    values (p_company_id, 'customer_recognition', p_enabled, v_actor, v_note,
            jsonb_build_object('previous', v_before, 'cleared_auto_links', v_cleared, 'reset_address_offers', v_offers));
  end if;
  return jsonb_build_object('company_id', p_company_id, 'enabled', p_enabled, 'changed', v_before is distinct from p_enabled,
                            'cleared_auto_links', v_cleared, 'reset_address_offers', v_offers);
end;
$$;

-- Lista as empresas com a flag ligada (visão do Admin Master).
create function public.master_whatsapp_customer_recognition_list()
returns table (company_id uuid, company_name text, enabled boolean, changed_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return query
    select s.company_id, c.name, s.customer_recognition_enabled,
           (select max(e.created_at) from public.whatsapp_feature_events e where e.company_id = s.company_id and e.feature = 'customer_recognition')
      from public.company_whatsapp_ai_settings s
      join public.companies c on c.id = s.company_id
     where s.customer_recognition_enabled
     order by c.name;
end;
$$;

revoke execute on function public.master_whatsapp_set_customer_recognition(uuid, boolean, text, boolean) from public, anon, service_role;
revoke execute on function public.master_whatsapp_customer_recognition_list() from public, anon, service_role;
grant execute on function public.master_whatsapp_set_customer_recognition(uuid, boolean, text, boolean) to authenticated;
grant execute on function public.master_whatsapp_customer_recognition_list() to authenticated;
