-- Pedido conversacional (WhatsApp AUTO): várias AMBIGUIDADES na mesma mensagem, resolvidas uma de cada vez.
--
-- Caso real (27/10/2026): "2 espetos de carne 3 espetos de frango 2 coca 3 cerveja haineken" tem DUAS menções ambíguas (coca, heineken).
-- O contexto de escolha só guarda UMA; a segunda era descartada ("me diga depois qual você quer") e a quantidade se perdia.
--   * whatsapp_order_choices.queue: fila (jsonb) das menções que ainda faltam resolver, na ordem em que o cliente escreveu
--     [{text, quantity, notes}]. Vive na MESMA linha do contexto pendente: expira, é cancelada ou é substituída junto com ele.
--   * whatsapp_order_choice_open: novo parâmetro p_queue (default '[]'); a fila é SANEADA aqui (no máx. 8 itens, texto <= 120,
--     quantidade 1..50 ou nula, observação <= 200). O worker antigo (6 argumentos) continua válido: cai no default.
--   * whatsapp_order_choice_resolve: devolve 'queue' no resultado ok; o worker reprocessa a fila pelo mesmo caminho do pedido
--     (catálogo do banco, quantidade guardada, próxima pergunta com letras).
-- Aditiva: não altera dados existentes (queue nasce '[]'), RLS/grants iguais.

alter table public.whatsapp_order_choices add column queue jsonb not null default '[]'::jsonb;
alter table public.whatsapp_order_choices
  add constraint whatsapp_order_choices_queue_check check (jsonb_typeof(queue) = 'array' and jsonb_array_length(queue) <= 8);

drop function public.whatsapp_order_choice_open(uuid, text, integer, text, uuid[], uuid);
create function public.whatsapp_order_choice_open(p_job_id uuid, p_source_text text, p_quantity integer, p_notes text, p_product_ids uuid[], p_expected_latest uuid default null, p_queue jsonb default '[]'::jsonb)
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
  v_queue jsonb;
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
  -- fila saneada: só objetos com texto; quantidade inteira 1..50 ou nula; observação curta; no máximo 8
  if jsonb_typeof(coalesce(p_queue, '[]'::jsonb)) <> 'array' then
    return jsonb_build_object('result', 'invalid', 'reason', 'queue_shape');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'text', left(btrim(q ->> 'text'), 120),
           'quantity', case when (q ->> 'quantity') ~ '^[0-9]{1,2}$' and (q ->> 'quantity')::integer between 1 and 50 then (q ->> 'quantity')::integer end,
           'notes', nullif(left(btrim(coalesce(q ->> 'notes', '')), 200), '')) order by ord), '[]'::jsonb)
    into v_queue
    from (select q, ord from jsonb_array_elements(coalesce(p_queue, '[]'::jsonb)) with ordinality as e(q, ord) limit 8) s
   where jsonb_typeof(q) = 'object' and btrim(coalesce(q ->> 'text', '')) <> '';
  select d.id into v_draft from public.whatsapp_order_drafts d
   where d.company_id = v_company and d.conversation_id = v_conv and d.status in ('collecting', 'awaiting_confirmation') order by d.created_at desc limit 1;
  update public.whatsapp_order_choices set status = 'cancelled', resolved_at = now() where conversation_id = v_conv and status = 'pending';
  insert into public.whatsapp_order_choices (company_id, conversation_id, draft_id, trigger_message_id, source_text, quantity, notes, options, queue)
  values (v_company, v_conv, v_draft, v_trigger, left(btrim(coalesce(p_source_text, '')), 200), p_quantity, nullif(left(btrim(coalesce(p_notes, '')), 200), ''), v_opts, v_queue)
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'replayed', false, 'choice_id', v_id, 'options', v_opts, 'status', 'pending', 'queue', v_queue);
end;
$$;
revoke execute on function public.whatsapp_order_choice_open(uuid, text, integer, text, uuid[], uuid, jsonb) from public, anon, authenticated;
grant execute on function public.whatsapp_order_choice_open(uuid, text, integer, text, uuid[], uuid, jsonb) to service_role;

-- resolve: igual à anterior, mas devolve a fila restante no resultado ok (a fila só é consumida pelo worker DEPOIS do item aplicado)
create or replace function public.whatsapp_order_choice_resolve(p_job_id uuid, p_choice_id uuid, p_letter text, p_message_id uuid, p_expected_latest uuid default null, p_tail_count integer default null)
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
  select * into v_ch from public.whatsapp_order_choices where id = p_choice_id and conversation_id = v_conv and company_id = v_company for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  v_pid := (select (o ->> 'product_id')::uuid from jsonb_array_elements(v_ch.options) o where o ->> 'letter' = v_letter);
  if v_ch.status = 'resolved' then
    if v_ch.resolved_message_id is not distinct from p_message_id and v_ch.resolved_letter = v_letter and v_pid is not null then
      v_d := public.whatsapp_order_open_draft(v_company, v_conv);
      return jsonb_build_object('result', 'ok', 'replayed', true, 'applied', v_ch.quantity is not null, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'queue', v_ch.queue,
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
    return jsonb_build_object('result', 'product_inactive');
  end if;
  if v_ch.quantity is not null then
    v_apply := public.whatsapp_order_apply_ops(p_job_id,
      jsonb_build_array(jsonb_build_object('op', 'add_item', 'product_id', v_pid, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'option_ids', '[]'::jsonb)),
      p_expected_latest, p_tail_count);
    if v_apply ->> 'result' <> 'ok' then
      return jsonb_build_object('result', case when v_apply ->> 'result' = 'blocked' then 'blocked' else 'apply_failed' end, 'reason', v_apply ->> 'reason', 'product', v_prod);
    end if;
  end if;
  update public.whatsapp_order_choices set status = 'resolved', resolved_letter = v_letter, resolved_message_id = p_message_id, resolved_at = now() where id = v_ch.id;
  return jsonb_build_object('result', 'ok', 'replayed', false, 'applied', v_ch.quantity is not null, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'queue', v_ch.queue, 'product', v_prod, 'state', v_apply -> 'state');
end;
$$;

-- ---------------------------------------------------------------------------
-- DURABILIDADE da fila: a fila continua na linha RESOLVIDA até ser consumida de forma ATÔMICA (aplicar itens + esvaziar na mesma
-- transação). Se o worker cair entre resolver a escolha e abrir a próxima, o reprocessamento a encontra (choice_get.pending_queue) e a
-- reexecuta sem duplicar item (queue_take é idempotente: fila vazia => 'empty'). Só vale com rascunho aberto (cancelado/confirmado = nada).
-- ---------------------------------------------------------------------------
create or replace function public.whatsapp_order_choice_get(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_conv uuid;
  v_company uuid;
  v_ch public.whatsapp_order_choices;
  v_pq jsonb;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;
  v_company := (v_ctx ->> 'company_id')::uuid;
  select jsonb_build_object('choice_id', c.id, 'queue', c.queue) into v_pq
    from public.whatsapp_order_choices c
   where c.conversation_id = v_conv and c.company_id = v_company and c.status = 'resolved' and jsonb_array_length(c.queue) > 0
     and exists (select 1 from public.whatsapp_order_drafts d where d.company_id = v_company and d.conversation_id = v_conv and d.status in ('collecting', 'awaiting_confirmation'))
   order by c.resolved_at desc limit 1;
  select * into v_ch from public.whatsapp_order_choices where conversation_id = v_conv and status = 'pending' for update;
  if not found then
    return jsonb_build_object('result', 'none', 'pending_queue', v_pq);
  end if;
  if v_ch.expires_at <= now() then
    update public.whatsapp_order_choices set status = 'expired', resolved_at = now() where id = v_ch.id;
    return jsonb_build_object('result', 'none', 'expired', true, 'pending_queue', v_pq);
  end if;
  return jsonb_build_object('result', 'ok', 'choice_id', v_ch.id, 'quantity', v_ch.quantity, 'notes', v_ch.notes, 'source_text', v_ch.source_text, 'created_at', v_ch.created_at, 'pending_queue', v_pq,
    'options', (select coalesce(jsonb_agg(jsonb_build_object('letter', o ->> 'letter', 'product_id', o ->> 'product_id', 'name', p.name, 'price', p.sale_price,
                                                             'active', coalesce(p.is_active, false) and coalesce(c.is_active, false),
                                                             'available', coalesce(p.is_active and c.is_active and p.available_for_sale and (p.stock_control = 'none' or p.stock_quantity > 0), false))
                                  order by o ->> 'letter'), '[]'::jsonb)
                  from jsonb_array_elements(v_ch.options) o
                  left join public.products p on p.company_id = v_ch.company_id and p.id = (o ->> 'product_id')::uuid
                  left join public.product_categories c on c.company_id = p.company_id and c.id = p.category_id));
end;
$$;

-- consome a fila de uma escolha RESOLVIDA: aplica os itens e esvazia a fila na MESMA transação (idempotente)
create function public.whatsapp_order_choice_queue_take(p_job_id uuid, p_choice_id uuid, p_ops jsonb default '[]'::jsonb, p_tail_count integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx jsonb := public.whatsapp_order_ctx(p_job_id);
  v_conv uuid;
  v_company uuid;
  v_ch public.whatsapp_order_choices;
  v_apply jsonb;
  v_d public.whatsapp_order_drafts;
begin
  if not (v_ctx ->> 'ok')::boolean then
    return jsonb_build_object('result', 'blocked', 'reason', v_ctx ->> 'reason');
  end if;
  v_conv := (v_ctx ->> 'conversation_id')::uuid;
  v_company := (v_ctx ->> 'company_id')::uuid;
  select * into v_ch from public.whatsapp_order_choices where id = p_choice_id and conversation_id = v_conv and company_id = v_company and status = 'resolved' for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if jsonb_array_length(v_ch.queue) = 0 then
    v_d := public.whatsapp_order_open_draft(v_company, v_conv);
    return jsonb_build_object('result', 'empty', 'state', case when v_d.id is not null then public.whatsapp_order_state(v_d.id) end);
  end if;
  if jsonb_typeof(coalesce(p_ops, '[]'::jsonb)) <> 'array' then
    return jsonb_build_object('result', 'invalid', 'reason', 'ops_shape');
  end if;
  v_apply := public.whatsapp_order_apply_ops(p_job_id, coalesce(p_ops, '[]'::jsonb), null, p_tail_count);
  if v_apply ->> 'result' <> 'ok' then
    return jsonb_build_object('result', case when v_apply ->> 'result' = 'blocked' then 'blocked' else 'apply_failed' end, 'reason', v_apply ->> 'reason');
  end if;
  update public.whatsapp_order_choices set queue = '[]'::jsonb where id = v_ch.id;
  return jsonb_build_object('result', 'ok', 'state', v_apply -> 'state');
end;
$$;
revoke execute on function public.whatsapp_order_choice_queue_take(uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_order_choice_queue_take(uuid, uuid, jsonb, integer) to service_role;
