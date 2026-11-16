-- Etapa 7.10B (LOCAL, NÃO aplicada): estrutura dos contatos MANUAIS do WhatsApp. Migration ADITIVA: só objetos novos.
-- Cria: whatsapp_contacts, whatsapp_contact_events, whatsapp_contact_normalize_phone, 2 funções de trigger. Nada existente é alterado
-- (nenhuma tabela, coluna, índice, política, trigger ou função existente). NÃO há RPCs de cadastro/edição/arquivamento/exclusão (7.10C),
-- NÃO muda a busca de Contatos (7.10D), NÃO há interface (7.10F) e NÃO há sincronização com a Meta.
--
-- Decisões (docs/whatsapp-contatos-manuais-plano): o contato manual é uma "agenda" independente de customers e de whatsapp_conversations:
--   * não copia dados de cliente (só o vínculo OPCIONAL customer_id) e não cria conversas (nada entra na caixa de entrada nem na fila da IA);
--   * identidade = telefone E.164 canônico; a chave de equivalência é a MESMA da busca (whatsapp_contact_key): com/sem o nono dígito
--     brasileiro é o mesmo contato, celular novo (9 + 1..5) e fixo continuam diferentes, outros países ficam como estão;
--   * duplicidade: índice único PARCIAL (empresa, chave) só para contatos ativos (arquivado não ocupa a chave);
--   * RLS ligado e NENHUM grant ao frontend: toda leitura/escrita virá por RPC SECURITY DEFINER (7.10C/D);
--   * auditoria em whatsapp_contact_events: append-only, SEM chave estrangeira para o contato (sobrevive à exclusão definitiva do dono,
--     prevista para depois) e sem o texto das observações (a RPC grava só quais campos mudaram).
-- Reservas para a sincronização futura (ficam inertes e travadas por constraint): source, external_id, synced_at.

-- ---------------------------------------------------------------------------
-- 1) Normalização do telefone digitado -> E.164 (só dígitos) ou NULL quando inválido
-- ---------------------------------------------------------------------------
-- Regras:
--   '+' no começo ........ internacional: 8 a 15 dígitos, sem zero inicial. Se começar com 55 vale a regra do Brasil abaixo.
--   sem '+', 10 ou 11 .... DDD + número do Brasil: ganha 55. (11 dígitos precisam do 9 de celular na 3ª posição.)
--   sem '+', 12 ou 13 .... só se começar com 55 (já com código do país).
--   qualquer outro tamanho (8/9 sem DDD, 14+, letras sem dígitos) => NULL. Número de outro país SEM '+' => NULL (evita confundir com BR).
-- Regra do Brasil (E.164 com 55): 12 ou 13 dígitos; DDD não começa com 0; 13 dígitos exigem o 9 na 5ª posição; 12 dígitos
-- (fixo ou celular antigo sem o 9) exigem 2..9 na 5ª posição. O telefone é guardado COMO FOI DIGITADO (com o 9, se veio com o 9);
-- só a chave (whatsapp_contact_key) descarta o 9 quando ele é equivalente (seguido de 6..9).
create function public.whatsapp_contact_normalize_phone(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when e is null then null
    when substr(e, 1, 2) = '55' then
      case
        when char_length(e) in (12, 13)
         and substr(e, 3, 1) between '1' and '9'
         and ((char_length(e) = 13 and substr(e, 5, 1) = '9') or (char_length(e) = 12 and substr(e, 5, 1) between '2' and '9'))
        then e
      end
    else e
  end
  from (
    select case
      when l = 0 then null
      when plus then case when l between 8 and 15 and substr(d, 1, 1) <> '0' then d end
      when l in (10, 11) then '55' || d
      when l in (12, 13) and substr(d, 1, 2) = '55' then d
      else null
    end as e
    from (
      select d, char_length(d) as l, coalesce(p_text, '') ~ '^[[:space:]]*[+]' as plus
        from (select regexp_replace(coalesce(p_text, ''), '[^0-9]', '', 'g') as d) z
    ) s
  ) t
$$;

revoke execute on function public.whatsapp_contact_normalize_phone(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Contatos manuais
-- ---------------------------------------------------------------------------
create table public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- telefone canônico (só dígitos, com código do país). A validade é conferida pela MESMA função que a RPC usará para normalizar.
  phone_e164 text not null
    constraint whatsapp_contacts_phone_check check (
      phone_e164 ~ '^[0-9]{8,15}$' and coalesce(public.whatsapp_contact_normalize_phone('+' || phone_e164) = phone_e164, false)),
  -- chave de equivalência (a mesma da busca de Contatos): com/sem o nono dígito = a mesma chave
  contact_key text generated always as (public.whatsapp_contact_key(phone_e164, false)) stored,
  name text not null
    constraint whatsapp_contacts_name_check check (char_length(name) between 1 and 80 and name = btrim(name)),
  notes text
    constraint whatsapp_contacts_notes_check check (notes is null or char_length(notes) between 1 and 1000),
  -- vínculo OPCIONAL com cliente existente da MESMA empresa. FK NO ACTION (regra do projeto para toda FK que aponta para customers):
  -- cliente ligado a um contato NÃO pode ser excluído enquanto o vínculo existir (a RPC de exclusão ganhará mensagem própria na 7.10C).
  customer_id uuid,
  -- origem. Hoje só 'manual'; a sincronização com a Meta (futura) ampliará esta constraint numa migration própria.
  source text not null default 'manual'
    constraint whatsapp_contacts_source_check check (source = 'manual'),
  external_id text,
  synced_at timestamptz,
  constraint whatsapp_contacts_sync_reserved_check check (external_id is null and synced_at is null),
  -- autoria: quem criou (fica nulo só se o usuário for apagado do Auth; nenhuma outra alteração é permitida)
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- arquivamento (reversível). Exclusão definitiva: etapa futura, só o dono, com confirmação e auditoria.
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  constraint whatsapp_contacts_archive_check check (archived_at is not null or archived_by is null),
  constraint whatsapp_contacts_customer_fkey
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint whatsapp_contacts_id_company_key unique (id, company_id)
);

comment on table public.whatsapp_contacts is
  'Contatos manuais do WhatsApp (agenda), independentes de customers e de whatsapp_conversations. Sem acesso direto do frontend: só RPC.';
comment on column public.whatsapp_contacts.contact_key is
  'Chave de equivalência (whatsapp_contact_key): mesmo valor com e sem o nono dígito brasileiro; outros países inalterados.';

-- UM contato ATIVO por empresa e telefone equivalente (arquivado não ocupa a chave; restaurar com chave ocupada é recusado pelo mesmo índice)
create unique index whatsapp_contacts_company_key_active_key
  on public.whatsapp_contacts (company_id, contact_key) where archived_at is null;
create index whatsapp_contacts_company_name_idx
  on public.whatsapp_contacts (company_id, lower(name)) where archived_at is null;
create index whatsapp_contacts_customer_idx
  on public.whatsapp_contacts (company_id, customer_id) where customer_id is not null;

-- Empresa, autoria e criação não mudam nunca (nem por superusuário distraído). Única exceção: o próprio Postgres soltando a autoria
-- (SET NULL) quando o usuário é apagado do Auth, que roda dentro do gatilho de integridade (profundidade > 1).
create function public.guard_whatsapp_contact_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.created_at is distinct from old.created_at
     or new.source is distinct from old.source
     or (new.created_by is distinct from old.created_by and not (new.created_by is null and pg_trigger_depth() > 1)) then
    raise exception 'Empresa, origem, autoria e criação de um contato não podem ser alteradas.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_contact_change() from public, anon, authenticated, service_role;

create trigger whatsapp_contacts_guard_change
  before update on public.whatsapp_contacts
  for each row execute function public.guard_whatsapp_contact_change();
create trigger whatsapp_contacts_set_updated_at
  before update on public.whatsapp_contacts
  for each row execute function public.set_updated_at();
-- empresa em modo somente leitura (PT402): mesma barreira e mesma mensagem das demais tabelas operacionais
create trigger guard_company_writable
  before insert or update or delete on public.whatsapp_contacts
  for each row execute function public.guard_company_writable();

-- ---------------------------------------------------------------------------
-- 3) Auditoria (append-only)
-- ---------------------------------------------------------------------------
-- contact_id SEM chave estrangeira DE PROPÓSITO: a trilha sobrevive à exclusão definitiva do contato. Só company_id cascateia
-- (apagar a empresa apaga a trilha dela). A RPC grava os campos que mudaram, nunca o texto das observações.
create table public.whatsapp_contact_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid not null,
  event_type text not null
    constraint whatsapp_contact_events_type_check check (event_type in (
      'created', 'updated', 'archived', 'restored', 'customer_linked', 'customer_unlinked', 'deleted')),
  actor_user_id uuid references auth.users(id) on delete set null,
  old_value jsonb constraint whatsapp_contact_events_old_check check (old_value is null or jsonb_typeof(old_value) = 'object'),
  new_value jsonb constraint whatsapp_contact_events_new_check check (new_value is null or jsonb_typeof(new_value) = 'object'),
  created_at timestamptz not null default now()
);
create index whatsapp_contact_events_idx on public.whatsapp_contact_events (company_id, contact_id, created_at);

comment on table public.whatsapp_contact_events is
  'Trilha de auditoria dos contatos manuais. Só acréscimo; sem FK para o contato (sobrevive à exclusão definitiva).';

-- Só acréscimo: UPDATE nunca (única exceção: o Postgres soltando o autor, SET NULL, quando o usuário é apagado do Auth, e SÓ essa coluna);
-- DELETE só quando vem do Postgres apagando a empresa (a cascata roda dentro do gatilho de integridade, profundidade > 1)
create function public.guard_whatsapp_contact_event()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if pg_trigger_depth() > 1 and new.actor_user_id is null and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
      return new;
    end if;
    raise exception 'Eventos de contato não podem ser alterados.' using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' and pg_trigger_depth() <= 1 then
    raise exception 'Eventos de contato não podem ser apagados.' using errcode = 'PT409';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke execute on function public.guard_whatsapp_contact_event() from public, anon, authenticated, service_role;

create trigger whatsapp_contact_events_append_only
  before update or delete on public.whatsapp_contact_events
  for each row execute function public.guard_whatsapp_contact_event();
create trigger guard_company_writable
  before insert on public.whatsapp_contact_events
  for each row execute function public.guard_company_writable();

-- ---------------------------------------------------------------------------
-- 4) RLS ligado, SEM nenhuma política e SEM grant ao frontend (acesso só por RPC SECURITY DEFINER, nas próximas etapas)
-- ---------------------------------------------------------------------------
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_contact_events enable row level security;
revoke all on public.whatsapp_contacts from public, anon, authenticated;
revoke all on public.whatsapp_contact_events from public, anon, authenticated;
grant all on public.whatsapp_contacts to service_role;
grant all on public.whatsapp_contact_events to service_role;
