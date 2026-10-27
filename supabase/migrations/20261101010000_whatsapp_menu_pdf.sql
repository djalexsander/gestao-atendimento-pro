-- WhatsApp + IA: cardápio em PDF enviado como DOCUMENTO pela Cloud API (media_id; nunca link).
--
-- Menor implementação segura: nada de cadastro paralelo de cardápio. O PDF é montado (Edge Function) a partir dos produtos REAIS
-- da empresa, lidos por UMA RPC de service_role que só enxerga a empresa do JOB. O envio reaproveita INTEGRALMENTE o commit do
-- modo automático (whatsapp_ai_auto_commit_send: módulos, modo auto, atendimento humano, janela de 24 h, modo teste, mensagem
-- nova do cliente, uma saída por job) e só troca o tipo da mensagem 'queued' para 'document' NA MESMA transação.
--
--   * company_whatsapp_ai_settings.menu_pdf_enabled (default false): trava por empresa, ligada por SQL (como order_drafts_enabled).
--   * whatsapp_menu_pdfs: o PDF vigente da empresa (hash do catálogo -> arquivo no bucket PRIVADO whatsapp-menu).
--   * whatsapp_menu_state: por conversa, a OFERTA do cardápio (pendente só enquanto a oferta for a última saída da conversa).
--   * RPCs só para service_role: whatsapp_ai_menu_context / _store / _register_offer / _commit_send.
-- Nada aqui altera produtos, preços, disponibilidade, pedidos, rascunhos ou idempotência existente.

-- 1) Trava por empresa
alter table public.company_whatsapp_ai_settings
  add column menu_pdf_enabled boolean not null default false;

comment on column public.company_whatsapp_ai_settings.menu_pdf_enabled is
  'Quando true (e whatsapp+ia ativos, modo auto), a IA envia o cardápio em PDF se o cliente pedir ou aceitar a oferta. Ajuste por SQL.';

-- 2) PDF vigente por empresa (cache por hash do catálogo)
create table public.whatsapp_menu_pdfs (
  company_id uuid primary key references public.companies(id) on delete cascade,
  catalog_hash text not null constraint whatsapp_menu_pdfs_hash_format check (catalog_hash ~ '^[0-9a-f]{32}$'),
  storage_path text not null,
  byte_size integer not null constraint whatsapp_menu_pdfs_size_check check (byte_size between 1 and 5242880),
  generated_at timestamptz not null default now(),
  -- o arquivo mora SEMPRE na pasta da própria empresa
  constraint whatsapp_menu_pdfs_path_shape check (storage_path = company_id::text || '/' || catalog_hash || '.pdf')
);
alter table public.whatsapp_menu_pdfs enable row level security;
revoke all on table public.whatsapp_menu_pdfs from public, anon, authenticated;

-- 3) Oferta por conversa
create table public.whatsapp_menu_state (
  conversation_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  offer_message_id uuid,
  offered_at timestamptz,
  last_sent_at timestamptz,
  constraint whatsapp_menu_state_conversation_fkey
    foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade
);
alter table public.whatsapp_menu_state enable row level security;
revoke all on table public.whatsapp_menu_state from public, anon, authenticated;

-- 4) Bucket PRIVADO (sem políticas: só service_role lê/escreve), 5 MiB, só PDF
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('whatsapp-menu', 'whatsapp-menu', false, 5242880, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 5) Contexto do cardápio para UM job. Só devolve algo se tudo estiver ligado; a empresa vem do JOB (nunca de parâmetro).
create function public.whatsapp_ai_menu_context(p_job_id uuid, p_with_catalog boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_conv public.whatsapp_conversations;
  v_s public.company_whatsapp_ai_settings;
  v_st public.whatsapp_menu_state;
  v_pdf public.whatsapp_menu_pdfs;
  v_live boolean;
  v_name text;
  v_catalog jsonb;
  v_count integer;
  v_hash text;
  v_pending boolean := false;
  v_allowed boolean := true;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('enabled', false, 'reason', 'job_missing');
  end if;
  select * into v_s from public.company_whatsapp_ai_settings where company_id = v_job.company_id;
  if not found or not v_s.menu_pdf_enabled then
    return jsonb_build_object('enabled', false, 'reason', 'menu_disabled');
  end if;
  if not public.whatsapp_ai_allowed(v_job.company_id) then
    return jsonb_build_object('enabled', false, 'reason', 'module_inactive');
  end if;
  if public.whatsapp_ai_effective_mode(v_s.enabled, v_s.mode, v_s.ai_data_processing_acknowledged_at, v_s.auto_acknowledged_at) <> 'auto' then
    return jsonb_build_object('enabled', false, 'reason', 'mode_not_auto');
  end if;
  select * into v_conv from public.whatsapp_conversations where id = v_job.conversation_id and company_id = v_job.company_id;
  if not found or v_conv.ai_control <> 'inherit' or v_conv.assigned_user_id is not null or v_conv.status = 'closed' then
    return jsonb_build_object('enabled', false, 'reason', 'human_or_closed');
  end if;

  v_live := v_s.ai_availability_mode = 'live';
  select coalesce(nullif(btrim(v_s.business_name), ''), c.name) into v_name from public.companies c where c.id = v_job.company_id;

  -- Mesmas regras do conhecimento da IA: produto ativo em categoria ativa; no modo 'live', também à venda e com saldo.
  select coalesce(jsonb_agg(jsonb_build_object('name', t.cname, 'products', t.prods) order by t.sort_order, t.cname), '[]'::jsonb),
         coalesce(sum(t.n), 0)::integer
    into v_catalog, v_count
    from (
      select c.name as cname, c.sort_order, count(p.id) as n,
             jsonb_agg(jsonb_build_object(
               'name', p.name,
               'description', nullif(left(btrim(coalesce(p.description, '')), 200), ''),
               'price', p.sale_price) order by p.name, p.id) as prods
        from public.product_categories c
        join public.products p on p.category_id = c.id and p.company_id = c.company_id
       where c.company_id = v_job.company_id and c.is_active and p.is_active
         and (not v_live or (p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0)))
       group by c.id, c.name, c.sort_order
    ) t;

  v_catalog := jsonb_build_object('company', v_name, 'categories', v_catalog);
  v_hash := md5(v_catalog::text);

  select * into v_st from public.whatsapp_menu_state where conversation_id = v_job.conversation_id;
  if found then
    v_allowed := v_st.offered_at is null and v_st.last_sent_at is null;
  end if;
  if v_st.conversation_id is not null and v_st.offer_message_id is not null and v_st.offered_at > now() - interval '24 hours' then
    v_pending := v_st.offer_message_id = (
      select o.id from public.whatsapp_messages o
       where o.conversation_id = v_job.conversation_id and o.company_id = v_job.company_id and o.direction = 'outbound'
       order by o.created_at desc, o.id desc limit 1);
  end if;

  select * into v_pdf from public.whatsapp_menu_pdfs where company_id = v_job.company_id;

  return jsonb_build_object(
    'enabled', true,
    'company_id', v_job.company_id,
    'company_name', v_name,
    'product_count', v_count,
    'catalog_hash', v_hash,
    'offer_pending', v_pending,
    -- só oferece uma vez por conversa (qualquer registro anterior de oferta ou envio impede nova oferta)
    'offer_allowed', v_allowed,
    'cached_path', case when v_pdf.company_id is not null and v_pdf.catalog_hash = v_hash then v_pdf.storage_path end,
    'catalog', case when p_with_catalog then v_catalog end);
end;
$$;

-- 6) Guarda o PDF gerado (o caminho precisa ser <empresa do job>/<hash>.pdf: isolamento por empresa)
create function public.whatsapp_ai_menu_store(p_job_id uuid, p_hash text, p_path text, p_size integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.whatsapp_ai_jobs where id = p_job_id;
  if v_company is null or p_hash is null or p_hash !~ '^[0-9a-f]{32}$' or p_path is distinct from v_company::text || '/' || p_hash || '.pdf' then
    return false;
  end if;
  insert into public.whatsapp_menu_pdfs (company_id, catalog_hash, storage_path, byte_size)
  values (v_company, p_hash, p_path, p_size)
  on conflict (company_id) do update
    set catalog_hash = excluded.catalog_hash, storage_path = excluded.storage_path,
        byte_size = excluded.byte_size, generated_at = now();
  return true;
end;
$$;

-- 7) Registra a OFERTA depois que a mensagem do job foi aceita pela Meta
create function public.whatsapp_ai_menu_register_offer(p_job_id uuid, p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg public.whatsapp_messages;
  v_job public.whatsapp_ai_jobs;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  select * into v_msg from public.whatsapp_messages where id = p_message_id;
  if v_job.id is null or v_msg.id is null
     or v_msg.ai_job_id is distinct from v_job.id or v_msg.company_id <> v_job.company_id
     or v_msg.conversation_id <> v_job.conversation_id or v_msg.direction <> 'outbound'
     or v_msg.status not in ('sent', 'delivered', 'read') then
    return false;
  end if;
  insert into public.whatsapp_menu_state (conversation_id, company_id, offer_message_id, offered_at)
  values (v_msg.conversation_id, v_msg.company_id, v_msg.id, now())
  on conflict (conversation_id) do update
    set offer_message_id = excluded.offer_message_id, offered_at = excluded.offered_at;
  return true;
end;
$$;

-- 8) Commit do DOCUMENTO: o mesmo commit do automático (todas as barreiras) + tipo 'document' na mesma transação
create function public.whatsapp_ai_menu_commit_send(p_job_id uuid, p_context_latest_message_id uuid, p_caption text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.whatsapp_ai_jobs;
  v_ctx jsonb;
  v_res jsonb;
begin
  select * into v_job from public.whatsapp_ai_jobs where id = p_job_id;
  if not found then
    return jsonb_build_object('result', 'not_active');
  end if;
  -- limite de legenda de documento da Meta
  if p_caption is null or char_length(btrim(p_caption)) = 0 or char_length(p_caption) > 1000 then
    return jsonb_build_object('result', 'abort', 'outcome', 'invalid_output', 'reason', 'invalid_body');
  end if;
  v_ctx := public.whatsapp_ai_menu_context(p_job_id, false);
  if coalesce((v_ctx ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('result', 'abort', 'outcome', 'aborted_mode', 'reason', 'menu_disabled');
  end if;
  -- catálogo mudou entre a geração e o envio, ou o arquivo vigente não é o que foi preparado: não envia versão velha
  if p_hash is distinct from v_ctx ->> 'catalog_hash' or v_ctx ->> 'cached_path' is null then
    return jsonb_build_object('result', 'stale');
  end if;

  v_res := public.whatsapp_ai_auto_commit_send(p_job_id, p_context_latest_message_id, p_caption);
  if v_res ->> 'result' = 'queued' then
    update public.whatsapp_messages set type = 'document' where id = (v_res ->> 'message_id')::uuid and status = 'queued';
    insert into public.whatsapp_menu_state (conversation_id, company_id, offer_message_id, last_sent_at)
    values (v_job.conversation_id, v_job.company_id, null, now())
    on conflict (conversation_id) do update set offer_message_id = null, last_sent_at = now();
  end if;
  return v_res;
end;
$$;

revoke execute on function public.whatsapp_ai_menu_context(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_menu_store(uuid, text, text, integer) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_menu_register_offer(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_ai_menu_commit_send(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_ai_menu_context(uuid, boolean) to service_role;
grant execute on function public.whatsapp_ai_menu_store(uuid, text, text, integer) to service_role;
grant execute on function public.whatsapp_ai_menu_register_offer(uuid, uuid) to service_role;
grant execute on function public.whatsapp_ai_menu_commit_send(uuid, uuid, text, text) to service_role;
