-- IA do WhatsApp — CONTEXTO AUTOMÁTICO da empresa (instruções opcionais + cadastro real como fonte principal).
--
-- ANTES: (1) o modo automático EXIGIA texto em "Instruções" (constraint + RPC + tela), então o cliente precisava digitar produtos, preços e regras à mão;
-- (2) a consulta ao cadastro (produtos, categorias, preços, horário, endereço, pagamento, entrega) só funcionava com company_whatsapp_ai_settings.knowledge_enabled = true,
-- um interruptor que NASCE FALSE e que nenhum cliente consegue ligar (só o operador, no banco): na prática a IA não via o cadastro e dependia do texto manual.
--
-- AGORA:
--   * "Instruções" é OPCIONAL em qualquer modo. O que já está cadastrado é preservado (nada é limpo). Servem para regras comerciais específicas.
--   * O cadastro real passa a ser consultado AUTOMATICAMENTE sempre que a IA responde: knowledge_enabled nasce TRUE e todas as linhas existentes passam a TRUE
--     (é a única mudança de dados: uma coluna de configuração; nenhuma instrução, produto, preço ou conexão é tocado). knowledge_enabled = false continua valendo como
--     DESLIGAMENTO explícito feito pelo operador (a RPC do cliente nunca o altera).
--   * A consulta (whatsapp_ai_knowledge_core) devolve também catalog_size = quantos produtos ativos (em categoria ativa) a empresa tem, para a IA distinguir
--     "nenhum produto corresponde à pergunta" de "a empresa ainda não cadastrou produtos" (nesse caso não inventa nada).
--   A empresa vem SEMPRE do job/conversa no banco (nunca de parâmetro do cliente); nada de uma empresa entra no contexto de outra.
-- NÃO MEXE: webhook, Coexistence, atendimento humano, envio, cobrança, módulos, pedidos da IA, cardápio em PDF, cotas, ack LGPD, horário, handoff.
-- Aditiva e reversível: supabase/rollbacks/whatsapp-ai-context-automatic/20261209010000_rollback.sql.

-- 1) auto sem instruções obrigatórias (a rede de segurança deixa de exigir texto)
alter table public.company_whatsapp_ai_settings drop constraint whatsapp_ai_settings_auto_requirements;
alter table public.company_whatsapp_ai_settings add constraint whatsapp_ai_settings_auto_requirements check (
  mode <> 'auto'
  or (enabled
      and ai_data_processing_acknowledged_at is not null
      and auto_acknowledged_at is not null));

-- 2) consulta ao cadastro ligada por padrão
alter table public.company_whatsapp_ai_settings alter column knowledge_enabled set default true;
-- guarda o valor ANTERIOR das linhas que mudam (só company_id e o valor), para o rollback poder restaurá-las; sem acesso de cliente
create table public.whatsapp_ai_knowledge_enabled_backup_20261209 (
  company_id uuid primary key,
  knowledge_enabled_before boolean not null,
  changed_at timestamptz not null default now()
);
alter table public.whatsapp_ai_knowledge_enabled_backup_20261209 enable row level security;
revoke all on public.whatsapp_ai_knowledge_enabled_backup_20261209 from public, anon, authenticated;
grant all on public.whatsapp_ai_knowledge_enabled_backup_20261209 to service_role;
insert into public.whatsapp_ai_knowledge_enabled_backup_20261209 (company_id, knowledge_enabled_before)
  select company_id, knowledge_enabled from public.company_whatsapp_ai_settings where knowledge_enabled is not true;
update public.company_whatsapp_ai_settings set knowledge_enabled = true where knowledge_enabled is not true;
comment on column public.company_whatsapp_ai_settings.knowledge_enabled is
  'TRUE (padrão) = a IA consulta o cadastro real da empresa (produtos, categorias, preços, horário, endereço, pagamento, entrega). FALSE = desligado pelo operador. Desde 20261209010000.';

-- 3) ajustes por substituição exata (falha fechada)
create or replace function pg_temp.patch_ai_fn(p_proc text, p_args text, p_from text, p_to text)
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
    raise exception 'patch_fn: função % não encontrada', p_proc;
  end if;
  v_def := replace(pg_get_functiondef(v_oid), chr(13), '');
  if (length(v_def) - length(replace(v_def, p_from, ''))) / greatest(length(p_from), 1) <> 1 then
    raise exception 'patch_fn: trecho esperado não ocorre exatamente 1 vez em %', p_proc;
  end if;
  execute replace(v_def, p_from, p_to);
end;
$$;

-- 3a) salvar configurações: o modo automático não exige mais instruções
select pg_temp.patch_ai_fn(
  'whatsapp_ai_update_settings',
  'p_company_id uuid, p_enabled boolean, p_mode text, p_business_name text, p_tone text, p_custom_instructions text, p_business_hours jsonb, p_fallback_to_human boolean, p_max_context_messages integer, p_acknowledge boolean, p_acknowledge_auto boolean, p_after_hours_policy text, p_after_hours_message text, p_business_schedule jsonb',
  $f$    if v_instr is null then
      raise exception 'Preencha as instruções da IA (produtos, preços e regras) antes de ativar o modo automático.' using errcode = 'PT409';
    end if;
$f$,
  $f$    -- instruções são OPCIONAIS: o contexto vem do cadastro real da empresa (produtos, horário, endereço, pagamento, entrega)
$f$);

-- 3b) consulta ao cadastro: tamanho do catálogo (produtos ativos em categoria ativa)
select pg_temp.patch_ai_fn(
  'whatsapp_ai_knowledge_core',
  'p_company_id uuid, p_query text, p_limit integer',
  $f$    'truncated', v_total > jsonb_array_length(v_products),
    'products', v_products,$f$,
  $f$    'truncated', v_total > jsonb_array_length(v_products),
    'catalog_size', (select count(*)::int from public.products p2
                       join public.product_categories c2 on c2.id = p2.category_id and c2.company_id = p2.company_id
                      where p2.company_id = v_company and p2.is_active and c2.is_active),
    'products', v_products,$f$);
