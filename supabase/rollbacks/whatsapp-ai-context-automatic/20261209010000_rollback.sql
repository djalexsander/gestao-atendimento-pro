-- Rollback da migration 20261209010000 (IA com contexto automático). Volta ao modelo anterior: instruções OBRIGATÓRIAS no modo automático e consulta ao cadastro
-- (knowledge_enabled) desligada por padrão e só ativável pelo operador.
-- O que faz: (1) restaura knowledge_enabled das linhas que a migration mudou (valor guardado em whatsapp_ai_knowledge_enabled_backup_20261209) e o padrão da coluna
-- (false); linhas criadas depois da migration (com padrão true) ficam como estão: o operador decide; (2) desfaz as duas substituições de função (substituição exata
-- inversa; cada trecho tem de ocorrer exatamente 1 vez, senão aborta); (3) recoloca a exigência de instruções no modo automático (constraint) — ABORTA, sem alterar nada,
-- se existir empresa em modo automático SEM instruções (preencha as instruções ou mude essa empresa para o modo manual antes); (4) remove a tabela de backup.
-- Não toca instruções, produtos, preços, conversas, mensagens, cotas, conexões, cobrança nem módulos.
-- Para poder reaplicar a migration depois:
--   node node_modules/supabase/dist/supabase.js migration repair --status reverted 20261209010000 --linked
begin;

do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.company_whatsapp_ai_settings
   where mode = 'auto' and nullif(btrim(coalesce(custom_instructions, '')), '') is null;
  if v_n > 0 then
    raise exception 'Rollback abortado: % empresa(s) em modo automático sem instruções. Preencha as instruções ou mude para o modo manual e tente de novo.', v_n;
  end if;
end;
$$;

create or replace function pg_temp.unpatch_ai_fn(p_proc text, p_args text, p_from text, p_to text)
returns void
language plpgsql
as $$
declare
  v_oid oid;
  v_def text;
begin
  select p.oid into v_oid from pg_proc p
   where p.proname = p_proc and p.pronamespace = 'public'::regnamespace and pg_get_function_identity_arguments(p.oid) = p_args;
  if v_oid is null then
    raise exception 'unpatch_fn: função % não encontrada', p_proc;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'unpatch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_proc;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

select pg_temp.unpatch_ai_fn(
  'whatsapp_ai_update_settings',
  'p_company_id uuid, p_enabled boolean, p_mode text, p_business_name text, p_tone text, p_custom_instructions text, p_business_hours jsonb, p_fallback_to_human boolean, p_max_context_messages integer, p_acknowledge boolean, p_acknowledge_auto boolean, p_after_hours_policy text, p_after_hours_message text, p_business_schedule jsonb',
  $f$    -- instruções são OPCIONAIS: o contexto vem do cadastro real da empresa (produtos, horário, endereço, pagamento, entrega)
$f$,
  $f$    if v_instr is null then
      raise exception 'Preencha as instruções da IA (produtos, preços e regras) antes de ativar o modo automático.' using errcode = 'PT409';
    end if;
$f$);

select pg_temp.unpatch_ai_fn(
  'whatsapp_ai_knowledge_core',
  'p_company_id uuid, p_query text, p_limit integer',
  $f$    'truncated', v_total > jsonb_array_length(v_products),
    'catalog_size', (select count(*)::int from public.products p2
                       join public.product_categories c2 on c2.id = p2.category_id and c2.company_id = p2.company_id
                      where p2.company_id = v_company and p2.is_active and c2.is_active),
    'products', v_products,$f$,
  $f$    'truncated', v_total > jsonb_array_length(v_products),
    'products', v_products,$f$);

alter table public.company_whatsapp_ai_settings drop constraint whatsapp_ai_settings_auto_requirements;
alter table public.company_whatsapp_ai_settings add constraint whatsapp_ai_settings_auto_requirements check (
  mode <> 'auto'
  or (enabled
      and ai_data_processing_acknowledged_at is not null
      and auto_acknowledged_at is not null
      and nullif(btrim(coalesce(custom_instructions, '')), '') is not null));

update public.company_whatsapp_ai_settings s
   set knowledge_enabled = b.knowledge_enabled_before
  from public.whatsapp_ai_knowledge_enabled_backup_20261209 b
 where b.company_id = s.company_id;
alter table public.company_whatsapp_ai_settings alter column knowledge_enabled set default false;
comment on column public.company_whatsapp_ai_settings.knowledge_enabled is
  'Base de conhecimento (futuro). Nasce FALSE e NÃO pode ser ligado enquanto a IA não consumir a base (Etapa 2).';
drop table public.whatsapp_ai_knowledge_enabled_backup_20261209;

commit;
