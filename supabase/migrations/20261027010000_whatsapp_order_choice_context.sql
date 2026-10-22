-- Pedido conversacional (WhatsApp AUTO): (1) tolerância a ERRO DE DIGITAÇÃO na resolução de produto e (2) contexto PERSISTENTE de
-- desambiguação por letras (A..E), com a quantidade/observação do item pendente.
--
--   * whatsapp_ai_edit_distance: distância de edição (Damerau, só transposição adjacente) com teto; função pura, sem extensão.
--   * whatsapp_order_resolve_item (create or replace, mesma assinatura): 1) todos os termos no nome; 2) sem descritores genéricos
--     (migration 20261026010000); 3) NOVO: cada termo (>= 5 letras) casa com algum token do nome com até 1 erro (2 se >= 8 letras).
--     Um único candidato por erro de digitação vira 'exact' (fuzzy=true); vários => 'ambiguous' (fuzzy=true). 'near' ganha product_id.
--   * whatsapp_order_choices: um contexto PENDENTE por conversa (índice único parcial), ligado à empresa/conversa/mensagem e ao
--     rascunho aberto; opções = ids reais de produto por letra; expira em 30 min; só o worker (service_role) escreve.
--   * RPCs choice_open / choice_get / choice_resolve / choice_cancel: tudo derivado do JOB (empresa e conversa vêm do banco).
-- Migration aditiva. RLS ligada; leitura só para owner/admin; escrita só pelas RPCs (SECURITY DEFINER, search_path fixo, service_role).

create function public.whatsapp_ai_edit_distance(p_a text, p_b text, p_max integer default 2)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  la integer := char_length(coalesce(p_a, ''));
  lb integer := char_length(coalesce(p_b, ''));
  prev2 integer[];
  prev integer[];
  cur integer[];
  i integer;
  j integer;
  cost integer;
  v integer;
begin
  if abs(la - lb) > p_max then return p_max + 1; end if;
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  prev2 := prev;
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      cost := case when substr(p_a, i, 1) = substr(p_b, j, 1) then 0 else 1 end;
      v := least(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
      if i > 1 and j > 1 and substr(p_a, i, 1) = substr(p_b, j - 1, 1) and substr(p_a, i - 1, 1) = substr(p_b, j, 1) then
        v := least(v, prev2[j - 1] + 1);
      end if;
      cur := cur || v;
    end loop;
    prev2 := prev;
    prev := cur;
  end loop;
  return prev[lb + 1];
end;
$$;
revoke execute on function public.whatsapp_ai_edit_distance(text, text, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- resolve_item com a 3ª etapa (erro de digitação)
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_order_resolve_item(p_job_id uuid, p_mention text, p_limit integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_company uuid;
  v_text text := left(btrim(coalesce(p_mention, '')), 120);
  v_norm text;
  v_req text[];
  v_req0 text[];
  v_soft constant text[] := array['lata', 'latinha', 'gelada', 'geladinha', 'refri', 'refrigerante', 'normal', 'tradicional', 'comum'];
  v_diet constant text[] := array['zero', 'diet', 'light'];
  v_normalish boolean;
  v_relaxed boolean := false;
  v_fuzzy boolean := false;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  v_ids uuid[];
  v_exact uuid[];
  v_near jsonb;
  v_p jsonb;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  v_norm := public.whatsapp_ai_norm_text(v_text);
  select coalesce(array_agg(t), '{}'::text[]) into v_req0
    from jsonb_array_elements_text(public.whatsapp_ai_knowledge_query_terms(v_text) -> 'required') t;
  v_req := v_req0;
  if cardinality(v_req) = 0 then
    return jsonb_build_object('result', 'none', 'near', '[]'::jsonb);
  end if;
  v_normalish := v_req && array['normal', 'tradicional', 'comum'];

  -- 1ª tentativa: produto ATIVO de categoria ATIVA cujo nome contém TODOS os termos do pedido
  select coalesce(array_agg(x.id order by x.name, x.id), '{}'::uuid[]),
         coalesce(array_agg(x.id order by x.name, x.id) filter (where x.nn = v_norm), '{}'::uuid[])
    into v_ids, v_exact
    from (
      select p.id, p.name, public.whatsapp_ai_norm_text(p.name) as nn,
             public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt
        from public.products p
        join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
       where p.company_id = v_company and p.is_active
    ) x
   where v_req <@ x.nt;

  -- 2ª tentativa: sem os descritores genéricos; nunca 'exact'
  if cardinality(v_ids) = 0 then   -- G2
    select coalesce(array_agg(t), '{}'::text[]) into v_req from unnest(v_req0) t where t <> all (v_soft);
    if cardinality(v_req) > 0 and v_req <> v_req0 then
      select coalesce(array_agg(x.id order by x.name, x.id), '{}'::uuid[])
        into v_ids
        from (
          select p.id, p.name, public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt
            from public.products p
            join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
           where p.company_id = v_company and p.is_active
        ) x
       where v_req <@ x.nt and (not v_normalish or not (x.nt && v_diet));
      v_exact := '{}'::uuid[];
      v_relaxed := cardinality(v_ids) > 0;
    end if;
  end if;

  -- 3ª tentativa: ERRO DE DIGITAÇÃO. Todos os termos precisam casar; só termos longos (>= 5 letras) aceitam erro (1; 2 se >= 8).
  if cardinality(v_ids) = 0 and cardinality(v_req) > 0 then
    select coalesce(array_agg(x.id order by x.name, x.id), '{}'::uuid[])
      into v_ids
      from (
        select p.id, p.name, public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) as nt
          from public.products p
          join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
         where p.company_id = v_company and p.is_active
      ) x
     where not exists (
       select 1 from unnest(v_req) t
        where not exists (
          select 1 from unnest(x.nt) n
           where n = t
              or (char_length(t) >= 5 and char_length(n) >= 4
                  and public.whatsapp_ai_edit_distance(t, n, case when char_length(t) >= 8 then 2 else 1 end) <= case when char_length(t) >= 8 then 2 else 1 end)))
       and (not v_normalish or not (x.nt && v_diet));
    v_exact := '{}'::uuid[];
    v_fuzzy := cardinality(v_ids) > 0;
  end if;

  if cardinality(v_exact) = 1 then
    v_ids := v_exact;
  end if;
  if cardinality(v_ids) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('product_id', y.id, 'name', y.name, 'price', y.sale_price) order by y.name, y.id), '[]'::jsonb) into v_near
      from (
        select p.id, p.name, p.sale_price
          from public.products p
          join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id and c.is_active
         where p.company_id = v_company and p.is_active
           and public.whatsapp_ai_knowledge_tokens(public.whatsapp_ai_norm_text(p.name)) && (select coalesce(array_agg(t), '{}'::text[]) from unnest(v_req0) t where t <> all (v_soft))
         order by p.name, p.id limit 5
      ) y;
    return jsonb_build_object('result', 'none', 'near', v_near);
  end if;
  if cardinality(v_ids) = 1 and not v_relaxed then
    v_p := public.whatsapp_order_product_json(v_company, v_ids[1]);
    return jsonb_build_object('result', case when (v_p ->> 'available')::boolean then 'exact' else 'unavailable' end, 'product', v_p, 'fuzzy', v_fuzzy);
  end if;
  return jsonb_build_object('result', 'ambiguous', 'relaxed', v_relaxed, 'fuzzy', v_fuzzy,
    'candidates', (select coalesce(jsonb_agg(public.whatsapp_order_product_json(v_company, i) order by ord), '[]'::jsonb)
                     from unnest(v_ids[1:v_limit]) with ordinality as u(i, ord)),
    'total_candidates', cardinality(v_ids));
end;
$$;

-- ---------------------------------------------------------------------------
-- Contexto persistente de desambiguação
-- ---------------------------------------------------------------------------
create table public.whatsapp_order_choices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  conversation_id uuid not null,
  draft_id uuid,
  trigger_message_id uuid not null,
  source_text text not null,
  quantity integer,
  notes text,
  options jsonb not null,
  status text not null default 'pending',
  resolved_letter text,
  resolved_message_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  resolved_at timestamptz,
  constraint whatsapp_order_choices_status_check check (status in ('pending', 'resolved', 'cancelled', 'expired')),
  constraint whatsapp_order_choices_text_length check (char_length(source_text) between 1 and 200),
  constraint whatsapp_order_choices_quantity_check check (quantity is null or quantity between 1 and 50),
  constraint whatsapp_order_choices_notes_length check (notes is null or char_length(notes) <= 200),
  constraint whatsapp_order_choices_options_check check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 5),
  constraint whatsapp_order_choices_letter_check check (resolved_letter is null or resolved_letter in ('A', 'B', 'C', 'D', 'E')),
  constraint whatsapp_order_choices_conversation_fkey foreign key (conversation_id, company_id) references public.whatsapp_conversations (id, company_id) on delete cascade,
  constraint whatsapp_order_choices_draft_fkey foreign key (draft_id, company_id) references public.whatsapp_order_drafts (id, company_id) on delete set null (draft_id),
  constraint whatsapp_order_choices_trigger_key unique (conversation_id, trigger_message_id)
);
create unique index whatsapp_order_choices_one_pending_idx on public.whatsapp_order_choices (conversation_id) where status = 'pending';
create index whatsapp_order_choices_company_idx on public.whatsapp_order_choices (company_id, created_at);

alter table public.whatsapp_order_choices enable row level security;
create policy whatsapp_order_choices_select on public.whatsapp_order_choices
  for select to authenticated
  using (
    public.company_has_module_rls(company_id, 'whatsapp')
    and public.user_role_in_company(company_id) in ('owner', 'admin')
  );
revoke all on public.whatsapp_order_choices from public, anon, authenticated, service_role;
grant select on public.whatsapp_order_choices to authenticated;

-- abre (ou reaproveita, pela mensagem) o contexto: cancela o pendente anterior da conversa
create function public.whatsapp_order_choice_open(p_job_id uuid, p_source_text text, p_quantity integer, p_notes text, p_product_ids uuid[], p_expected_latest uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id, p_expected_latest);
  v_company uuid;
  v_conv uuid;
  v_trigger uuid;
  v_ids uuid[];
  v_opts jsonb;
  v_old public.whatsapp_order_choices;
  v_draft uuid;
  v_id uuid;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_company := (v_ctx ->> 'company_id')::uuid;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;
  v_trigger := (v_ctx ->> 'latest_message_id')::uuid;
  -- mesma mensagem (reprocessamento do job): devolve o contexto que já existe
  select * into v_old from public.whatsapp_order_choices where conversation_id = v_conv and trigger_message_id = v_trigger;
  if found then
    return jsonb_build_object('result', 'ok', 'replayed', true, 'choice_id', v_old.id, 'options', v_old.options, 'status', v_old.status);
  end if;
  -- só produtos ATIVOS desta empresa, sem repetição, no máximo 5, na ordem recebida
  select coalesce(array_agg(u.id order by u.ord), '{}'::uuid[]) into v_ids
    from (
      select distinct on (x.id) x.id, x.ord
        from unnest(coalesce(p_product_ids, '{}'::uuid[])) with ordinality as x(id, ord)
        join public.products p on p.company_id = v_company and p.id = x.id and p.is_active
        order by x.id, x.ord
    ) u;
  v_ids := v_ids[1:5];
  if coalesce(cardinality(v_ids), 0) = 0 then
    return jsonb_build_object('result', 'invalid', 'reason', 'no_products');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('letter', chr(64 + ord::integer), 'product_id', i) order by ord), '[]'::jsonb) into v_opts
    from unnest(v_ids) with ordinality as o(i, ord);
  select d.id into v_draft from public.whatsapp_order_drafts d
   where d.company_id = v_company and d.conversation_id = v_conv and d.status in ('collecting', 'awaiting_confirmation') order by d.created_at desc limit 1;
  update public.whatsapp_order_choices set status = 'cancelled', resolved_at = now() where conversation_id = v_conv and status = 'pending';
  insert into public.whatsapp_order_choices (company_id, conversation_id, draft_id, trigger_message_id, source_text, quantity, notes, options)
  values (v_company, v_conv, v_draft, v_trigger, left(btrim(coalesce(p_source_text, '')), 200), p_quantity, nullif(left(btrim(coalesce(p_notes, '')), 200), ''), v_opts)
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'replayed', false, 'choice_id', v_id, 'options', v_opts, 'status', 'pending');
end;
$$;

-- contexto ATIVO da conversa do job (expira o vencido), com os produtos como estão AGORA no catálogo
create function public.whatsapp_order_choice_get(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_conv uuid;
  v_ch public.whatsapp_order_choices;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;
  select * into v_ch from public.whatsapp_order_choices where conversation_id = v_conv and status = 'pending' for update;
  if not found then
    return jsonb_build_object('result', 'none');
  end if;
  if v_ch.expires_at <= now() then
    update public.whatsapp_order_choices set status = 'expired', resolved_at = now() where id = v_ch.id;
    return jsonb_build_object('result', 'none', 'expired', true);
  end if;
  return jsonb_build_object('result', 'ok', 'choice_id', v_ch.id, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'source_text', v_ch.source_text, 'created_at', v_ch.created_at,
    'options', (select coalesce(jsonb_agg(jsonb_build_object('letter', o ->> 'letter', 'product_id', o ->> 'product_id', 'name', p.name, 'price', p.sale_price,
                                                             'active', coalesce(p.is_active, false) and coalesce(c.is_active, false),
                                                             'available', coalesce(p.is_active and c.is_active and p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0), false))
                                  order by o ->> 'letter'), '[]'::jsonb)
                  from jsonb_array_elements(v_ch.options) o
                  left join public.products p on p.company_id = v_ch.company_id and p.id = (o ->> 'product_id')::uuid
                  left join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id));
end;
$$;

-- escolhe a letra: valida a opção e o produto de AGORA, APLICA o item no rascunho e marca como resolvido, TUDO na mesma transação
-- (um acidente entre "marcar resolvido" e "adicionar o item" não pode perder o pedido do cliente). Idempotente pela mensagem.
create function public.whatsapp_order_choice_resolve(p_job_id uuid, p_choice_id uuid, p_letter text, p_message_id uuid, p_expected_latest uuid default null, p_tail_count integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id, p_expected_latest);
  v_conv uuid;
  v_company uuid;
  v_ch public.whatsapp_order_choices;
  v_letter text := upper(btrim(coalesce(p_letter, '')));
  v_pid uuid;
  v_prod jsonb;
  v_apply jsonb;
  v_d public.whatsapp_order_drafts;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;
  v_company := (v_ctx ->> 'company_id')::uuid;
  -- a conversa já está travada por whatsapp_order_ctx; o FOR UPDATE serializa também duas escolhas da mesma linha
  select * into v_ch from public.whatsapp_order_choices where id = p_choice_id and conversation_id = v_conv and company_id = v_company for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  v_pid := (select (o ->> 'product_id')::uuid from jsonb_array_elements(v_ch.options) o where o ->> 'letter' = v_letter);
  if v_ch.status = 'resolved' then
    -- reprocessamento da MESMA mensagem: o item JÁ foi aplicado; devolve o mesmo resultado (com o estado atual); outra mensagem: já resolvido
    if v_ch.resolved_message_id is not distinct from p_message_id and v_ch.resolved_letter = v_letter and v_pid is not null then
      v_d := public.whatsapp_order_open_draft(v_company, v_conv);
      return jsonb_build_object('result', 'ok', 'replayed', true, 'applied', v_ch.quantity is not null, 'quantity', v_ch.quantity, 'notes', v_ch.notes,
        'product', public.whatsapp_order_product_json(v_company, v_pid), 'state', case when v_d.id is not null then public.whatsapp_order_state(v_d.id) end);
    end if;
    return jsonb_build_object('result', 'already_resolved');
  end if;
  if v_ch.status <> 'pending' then
    return jsonb_build_object('result', v_ch.status);
  end if;
  if v_ch.expires_at <= now() then
    update public.whatsapp_order_choices set status = 'expired', resolved_at = now() where id = v_ch.id;
    return jsonb_build_object('result', 'expired');
  end if;
  if v_pid is null then
    return jsonb_build_object('result', 'invalid_letter');
  end if;
  v_prod := public.whatsapp_order_product_json(v_company, v_pid);
  if v_prod is null or not exists (select 1 from public.products p join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id
                                    where p.company_id = v_company and p.id = v_pid and p.is_active and c.is_active) then
    return jsonb_build_object('result', 'product_inactive');   -- continua pendente: o cliente escolhe outra letra
  end if;
  if v_ch.quantity is not null then
    -- preço, nome e estoque vêm do catálogo de AGORA (apply_ops); quantidade e observação são as do pedido original
    v_apply := public.whatsapp_order_apply_ops(p_job_id,
      jsonb_build_array(jsonb_build_object('op', 'add_item', 'product_id', v_pid, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'option_ids', '[]'::jsonb)),
      p_expected_latest, p_tail_count);
    if v_apply ->> 'result' <> 'ok' then
      -- nada foi resolvido: o contexto continua pendente (contexto velho, produto sem estoque, limite do rascunho...)
      return jsonb_build_object('result', case when v_apply ->> 'result' = 'blocked' then 'blocked' else 'apply_failed' end, 'reason', v_apply ->> 'reason', 'product', v_prod);
    end if;
  end if;
  update public.whatsapp_order_choices set status = 'resolved', resolved_letter = v_letter, resolved_message_id = p_message_id, resolved_at = now() where id = v_ch.id;
  return jsonb_build_object('result', 'ok', 'replayed', false, 'applied', v_ch.quantity is not null, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'product', v_prod, 'state', v_apply -> 'state');
end;
$$;

-- cancela o contexto pendente da conversa do job (outra instrução, desistência)
create function public.whatsapp_order_choice_cancel(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_n integer;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  update public.whatsapp_order_choices set status = 'cancelled', resolved_at = now()
   where conversation_id = (v_ctx ->> 'conversation_id')::uuid and company_id = (v_ctx ->> 'company_id')::uuid and status = 'pending';
  get diagnostics v_n = row_count;
  return jsonb_build_object('result', 'ok', 'cancelled', v_n);
end;
$$;

revoke execute on function public.whatsapp_order_choice_open(uuid, text, integer, text, uuid[], uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_order_choice_get(uuid) from public, anon, authenticated;
revoke execute on function public.whatsapp_order_choice_resolve(uuid, uuid, text, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.whatsapp_order_choice_cancel(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_order_choice_open(uuid, text, integer, text, uuid[], uuid) to service_role;
grant execute on function public.whatsapp_order_choice_get(uuid) to service_role;
grant execute on function public.whatsapp_order_choice_resolve(uuid, uuid, text, uuid, uuid, integer) to service_role;
grant execute on function public.whatsapp_order_choice_cancel(uuid) to service_role;
