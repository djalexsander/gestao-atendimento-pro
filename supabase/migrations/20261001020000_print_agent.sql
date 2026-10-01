-- Impressão — ETAPA 2: Agente de Impressão do Windows (pareamento, credencial própria, binding físico,
-- claim atômico da fila, concluir/falhar, revogação). O executável fica em apps/print-agent; ESC/POS e
-- impressão física NÃO fazem parte desta etapa (o agente só SIMULA a impressão e chama complete_print_job).
--
-- Modelo de segurança:
--   * O agente NUNCA usa service_role nem login de usuário. Ele conhece a URL e a chave pública (anon) do
--     Supabase e se autentica em cada RPC com (agent_id, token). O token (244 bits aleatórios) é emitido
--     UMA vez no pareamento; o banco guarda só o sha256 (token_hash) e a coluna não é legível pelo cliente.
--   * Pareamento: owner/admin gera um código de 8 dígitos (uso único, 10 min, vinculado à empresa, só o
--     hash é guardado; gerar outro invalida os anteriores). O agente chama pair_print_agent (única RPC
--     acessível sem sessão de usuário, além das que exigem token). Força bruta: 8 dígitos (10^8) + limite
--     PRINCIPAL de 5 tentativas ERRADAS por machine_id em 10 minutos (print_agent_pair_attempts) e um circuit
--     breaker GLOBAL só contra abuso extremo (200 erradas em 10 min em todo o sistema), depois "rate_limited"
--     mesmo para código certo. Um limite global baixo deixaria qualquer pessoa bloquear o pareamento de TODAS as
--     empresas, por isso o global é alto. Atenção: machine_id é escolhido pelo cliente, então faz parte da defesa
--     mas NÃO é identidade criptográfica (quem troca o machine_id a cada tentativa escapa do limite por máquina);
--     o que segura esse caso é a entropia (10^8), a validade de 10 min, o uso único e o breaker global.
--     Falhas voltam como resultado (não exceção) para a tentativa ficar gravada; tudo se libera sozinho.
--   * Ready: print_devices.is_ready (010000) continua gerada = ativa + agent_id + windows_printer_name +
--     bound_at. Esta migration só liga agent_id a print_agents por FK composta; vincular/desvincular/
--     revogar limpam as três colunas do vínculo, então is_ready cai sozinho.
--
-- Fila:
--   * claim_print_jobs: uma transação, jobs pending das impressoras vinculadas AO AGENTE e prontas,
--     FOR UPDATE SKIP LOCKED, no máximo 10 por chamada (padrão 5), mais antigos primeiro; marca claimed,
--     attempts+1, claimed_at, claimed_by_agent_id. Dois agentes/ciclos concorrentes nunca recebem o mesmo job.
--   * Recuperação CONSERVADORA: job claimed há mais de 5 min por um agente que sumiu NÃO volta para pending
--     (poderia imprimir duas vezes); vira error com aviso para conferir o papel, e o admin reimprime
--     conscientemente pela fila. Só quem claimou (claimed_by_agent_id) conclui ou falha o job.
--   * Desvincular (owner/admin): jobs pending -> cancelled; se há claim recente (< 5 min) a operação é
--     RECUSADA ("impressão em andamento"); claim antigo -> error. Revogar o agente não pode esperar (o token
--     morre na hora): pending -> cancelled e claimed -> error (pode ou não ter saído papel).
-- Quem pode o quê: gerar código, ver agentes, desvincular e revogar = owner/admin (cliente só tem SELECT em
-- print_agents, sem token_hash); o agente só age pelas RPCs com token.

create table public.print_agents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null
    constraint print_agents_name_length check (char_length(name) between 1 and 80),
  -- UUID gerado localmente na 1ª execução do agente (nada de serial/MAC/hardware).
  machine_id text not null
    constraint print_agents_machine_id_format check (machine_id ~ '^[A-Za-z0-9-]{8,64}$'),
  machine_name text
    constraint print_agents_machine_name_length check (machine_name is null or char_length(machine_name) between 1 and 80),
  token_hash text not null
    constraint print_agents_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint print_agents_revoke_consistency check (
    (is_active and revoked_at is null) or (not is_active and revoked_at is not null)
  ),
  constraint print_agents_company_id_id_key unique (company_id, id)
);

-- Um mesmo computador (machine_id) não duplica na empresa enquanto o agente não foi revogado.
create unique index print_agents_active_machine_key
  on public.print_agents (company_id, machine_id) where revoked_at is null;
create index print_agents_company_idx on public.print_agents (company_id);
create index print_agents_created_by_idx on public.print_agents (created_by) where created_by is not null;

create trigger print_agents_set_updated_at
  before update on public.print_agents
  for each row execute function public.set_updated_at();

comment on table public.print_agents is
  'Agentes de Impressão (um por computador). Credencial própria: token_hash = sha256 do token emitido no pareamento (nunca legível pelo cliente). Revogar = is_active=false + revoked_at; nunca apagar.';

create function public.guard_print_agent_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is distinct from old.company_id or new.created_at is distinct from old.created_at then
    raise exception 'Os dados de origem de um agente não podem ser alterados.' using errcode = 'PT409';
  end if;
  if not old.is_active and new.is_active then
    raise exception 'Um agente revogado não pode ser reativado. Conecte o computador de novo.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger print_agents_guard_change
  before update on public.print_agents
  for each row execute function public.guard_print_agent_change();
revoke execute on function public.guard_print_agent_change() from public, anon, authenticated;

alter table public.print_agents enable row level security;
create policy print_agents_select on public.print_agents
  for select to authenticated
  using (public.user_role_in_company(company_id) in ('owner', 'admin'));
revoke all on public.print_agents from anon, authenticated;
-- SELECT por COLUNA: token_hash nunca sai pelo cliente.
grant select (id, company_id, name, machine_id, machine_name, is_active, last_seen_at, created_by, created_at, updated_at, revoked_at)
  on public.print_agents to authenticated;
grant all on public.print_agents to service_role;

-- Códigos de pareamento (só o hash).
create table public.print_agent_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code_hash text not null
    constraint print_agent_pairing_codes_hash_format check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index print_agent_pairing_codes_hash_key
  on public.print_agent_pairing_codes (code_hash) where used_at is null;
create index print_agent_pairing_codes_company_idx on public.print_agent_pairing_codes (company_id, created_at desc);
create index print_agent_pairing_codes_created_by_idx on public.print_agent_pairing_codes (created_by) where created_by is not null;

comment on table public.print_agent_pairing_codes is
  'Códigos de pareamento temporários (uso único, 10 min). Só o hash é guardado; ninguém lê esta tabela pelo cliente.';

alter table public.print_agent_pairing_codes enable row level security;
revoke all on public.print_agent_pairing_codes from anon, authenticated;
grant all on public.print_agent_pairing_codes to service_role;

-- Tentativas ERRADAS de pareamento (limite de força bruta).
create table public.print_agent_pair_attempts (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  attempted_at timestamptz not null default now()
);
create index print_agent_pair_attempts_at_idx on public.print_agent_pair_attempts (attempted_at);
create index print_agent_pair_attempts_machine_idx on public.print_agent_pair_attempts (machine_id, attempted_at);
alter table public.print_agent_pair_attempts enable row level security;
revoke all on public.print_agent_pair_attempts from anon, authenticated;
grant all on public.print_agent_pair_attempts to service_role;

-- ---------------------------------------------------------------------------
-- Ligações com a fundação (010000)
-- ---------------------------------------------------------------------------
alter table public.print_devices
  add constraint print_devices_agent_fkey
  foreign key (company_id, agent_id) references public.print_agents (company_id, id);
create index print_devices_agent_idx on public.print_devices (agent_id) where agent_id is not null;

-- Perfil ESC/POS por impressora lógica (configuração do papel; não altera nada no Windows).
alter table public.print_devices
  add column escpos_profile text not null default 'generic_escpos'
    constraint print_devices_escpos_profile_check check (escpos_profile in ('generic_escpos')),
  add column escpos_codepage text not null default 'cp850'
    constraint print_devices_escpos_codepage_check check (escpos_codepage in ('cp850', 'cp860', 'cp1252')),
  add column cut_mode text not null default 'partial'
    constraint print_devices_cut_mode_check check (cut_mode in ('none', 'partial', 'full'));

alter table public.print_jobs add column claimed_by_agent_id uuid;
alter table public.print_jobs
  add constraint print_jobs_claimed_agent_fkey
  foreign key (company_id, claimed_by_agent_id) references public.print_agents (company_id, id);
create index print_jobs_claimed_agent_idx on public.print_jobs (claimed_by_agent_id) where claimed_by_agent_id is not null;
create index print_jobs_agent_pending_idx on public.print_jobs (company_id, created_at, id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create function public.print_claim_timeout()
returns interval
language sql
immutable
set search_path = public
as $$ select interval '5 minutes' $$;
revoke execute on function public.print_claim_timeout() from public, anon, authenticated;

create function public.print_token_hash(p_token text)
returns text
language sql
immutable
set search_path = public
as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;
revoke execute on function public.print_token_hash(text) from public, anon, authenticated;

-- Autentica o agente. Mensagem única para qualquer falha (não revela se o agente existe).
create function public.print_agent_auth(p_agent_id uuid, p_token text)
returns public.print_agents
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
begin
  select * into v_agent
  from public.print_agents
  where id = p_agent_id
    and is_active
    and revoked_at is null
    and token_hash = public.print_token_hash(p_token);
  if not found then
    raise exception 'Agente não autorizado.' using errcode = 'PT401';
  end if;
  return v_agent;
end;
$$;
revoke execute on function public.print_agent_auth(uuid, text) from public, anon, authenticated;

-- Solta o vínculo físico de uma impressora e trata os jobs em aberto (ver cabeçalho).
create function public.release_print_device(p_device_id uuid, p_reason text, p_forbid_live_claim boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
begin
  select * into v_device from public.print_devices where id = p_device_id for update;
  if not found then
    return;
  end if;

  if p_forbid_live_claim and exists (
    select 1 from public.print_jobs j
    where j.print_device_id = v_device.id and j.status = 'claimed'
      and j.claimed_at > now() - public.print_claim_timeout()
  ) then
    raise exception 'Há uma impressão em andamento nesta impressora. Aguarde alguns instantes e tente de novo.' using errcode = 'PT409';
  end if;

  update public.print_jobs
     set status = 'cancelled', error_message = left(p_reason, 500)
   where print_device_id = v_device.id and status = 'pending';
  update public.print_jobs
     set status = 'error', error_message = left(p_reason || ' Confira se o papel saiu antes de reimprimir.', 500)
   where print_device_id = v_device.id and status = 'claimed';

  update public.print_devices
     set agent_id = null, windows_printer_name = null, bound_at = null
   where id = v_device.id;
end;
$$;
revoke execute on function public.release_print_device(uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs do PWA (owner/admin)
-- ---------------------------------------------------------------------------
create function public.create_print_agent_pairing_code(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.company_role;
  v_code text;
  v_expires timestamptz := now() + interval '10 minutes';
  v_try integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  v_role := public.user_role_in_company(p_company_id);
  if v_role is null then
    raise exception 'Empresa não encontrada.' using errcode = 'PT404';
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para conectar computadores.' using errcode = 'PT403';
  end if;

  -- Um código por vez: os anteriores ainda válidos deixam de valer.
  update public.print_agent_pairing_codes
     set expires_at = now()
   where company_id = p_company_id and used_at is null and expires_at > now();

  loop
    v_try := v_try + 1;
    -- 8 dígitos a partir de bytes do CSPRNG (gen_random_uuid).
    v_code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint % 100000000)::text, 8, '0');
    begin
      insert into public.print_agent_pairing_codes (company_id, code_hash, expires_at, created_by)
      values (p_company_id, public.print_token_hash(v_code), v_expires, auth.uid());
      exit;
    exception when unique_violation then
      if v_try >= 5 then
        raise exception 'Não foi possível gerar o código agora. Tente de novo.' using errcode = 'PT409';
      end if;
    end;
  end loop;

  return jsonb_build_object('code', v_code, 'expires_at', v_expires, 'ttl_seconds', 600);
end;
$$;

create function public.unbind_print_device(p_device_id uuid)
returns public.print_devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.print_devices;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_device from public.print_devices where id = p_device_id;
  if not found or public.user_role_in_company(v_device.company_id) is null then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_device.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para desvincular impressoras.' using errcode = 'PT403';
  end if;

  perform public.release_print_device(p_device_id, 'Impressora física desvinculada.', true);
  select * into v_device from public.print_devices where id = p_device_id;
  return v_device;
end;
$$;

create function public.revoke_print_agent(p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_device uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.' using errcode = 'PT401';
  end if;
  select * into v_agent from public.print_agents where id = p_agent_id;
  if not found or public.user_role_in_company(v_agent.company_id) is null then
    raise exception 'Agente não encontrado.' using errcode = 'PT404';
  end if;
  if public.user_role_in_company(v_agent.company_id) not in ('owner', 'admin') then
    raise exception 'Você não tem permissão para revogar agentes.' using errcode = 'PT403';
  end if;

  select * into v_agent from public.print_agents where id = p_agent_id for update;
  if not v_agent.is_active then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  -- Revogar não espera claim: o token deixa de valer agora.
  for v_device in select id from public.print_devices where agent_id = v_agent.id order by id loop
    perform public.release_print_device(v_device, 'Agente de Impressão revogado.', false);
  end loop;

  update public.print_agents set is_active = false, revoked_at = now() where id = v_agent.id;
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

revoke execute on function public.create_print_agent_pairing_code(uuid) from public, anon;
revoke execute on function public.unbind_print_device(uuid) from public, anon;
revoke execute on function public.revoke_print_agent(uuid) from public, anon;
grant execute on function public.create_print_agent_pairing_code(uuid) to authenticated;
grant execute on function public.unbind_print_device(uuid) to authenticated;
grant execute on function public.revoke_print_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPCs do AGENTE (sem sessão de usuário: validam agent_id + token)
-- ---------------------------------------------------------------------------
-- Pareamento. Resultado, não exceção, para que a tentativa errada fique gravada.
create function public.pair_print_agent(p_code text, p_machine_id text, p_machine_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := regexp_replace(coalesce(p_code, ''), '\s', '', 'g');
  v_name text := btrim(coalesce(p_machine_name, ''));
  v_row public.print_agent_pairing_codes;
  v_agent public.print_agents;
  v_token text;
  v_company_name text;
begin
  if p_machine_id is null or p_machine_id !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'Identificador do computador inválido.' using errcode = 'PT400';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Informe o nome do computador (até 80 caracteres).' using errcode = 'PT400';
  end if;

  delete from public.print_agent_pair_attempts where attempted_at < now() - interval '1 day';
  -- Principal: 5 erradas por machine_id / 10 min. Breaker global (200 / 10 min): só abuso extremo.
  if (select count(*) from public.print_agent_pair_attempts
      where machine_id = p_machine_id and attempted_at > now() - interval '10 minutes') >= 5
     or (select count(*) from public.print_agent_pair_attempts
         where attempted_at > now() - interval '10 minutes') >= 200 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  if v_code !~ '^[0-9]{8}$' then
    insert into public.print_agent_pair_attempts (machine_id) values (p_machine_id);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  select * into v_row
  from public.print_agent_pairing_codes
  where code_hash = public.print_token_hash(v_code) and used_at is null and expires_at > now()
  for update;
  if not found then
    insert into public.print_agent_pair_attempts (machine_id) values (p_machine_id);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  update public.print_agent_pairing_codes set used_at = now() where id = v_row.id;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  select * into v_agent from public.print_agents
  where company_id = v_row.company_id and machine_id = p_machine_id and revoked_at is null for update;
  if found then
    -- Mesmo computador reconectando: novo token, mesmos vínculos.
    update public.print_agents
       set token_hash = public.print_token_hash(v_token), name = v_name, machine_name = v_name, last_seen_at = now()
     where id = v_agent.id returning * into v_agent;
  else
    insert into public.print_agents (company_id, name, machine_id, machine_name, token_hash, last_seen_at, created_by)
    values (v_row.company_id, v_name, p_machine_id, v_name, public.print_token_hash(v_token), now(), v_row.created_by)
    returning * into v_agent;
  end if;

  select name into v_company_name from public.companies where id = v_row.company_id;
  return jsonb_build_object('ok', true, 'agent_id', v_agent.id, 'token', v_token,
                            'agent_name', v_agent.name, 'company_name', v_company_name);
end;
$$;

create function public.print_agent_heartbeat(p_agent_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  update public.print_agents set last_seen_at = now() where id = v_agent.id;
  return jsonb_build_object(
    'ok', true, 'server_time', now(), 'agent_name', v_agent.name,
    'company_name', (select name from public.companies where id = v_agent.company_id)
  );
end;
$$;

-- Impressoras lógicas da empresa (para o agente vincular), com os destinos.
create function public.list_agent_print_devices(p_agent_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'paper_width', d.paper_width,
      'windows_printer_name', d.windows_printer_name,
      'escpos_codepage', d.escpos_codepage, 'cut_mode', d.cut_mode,
      'is_ready', d.is_ready,
      'bound_to_me', d.agent_id = v_agent.id,
      'bound_to_other', d.agent_id is not null and d.agent_id <> v_agent.id,
      'full_order', exists (select 1 from public.print_device_routes r where r.print_device_id = d.id and r.route_type = 'full_order'),
      'sectors', coalesce((select jsonb_agg(s.name order by s.name) from public.print_device_routes r
                           join public.production_sectors s on s.company_id = r.company_id and s.id = r.production_sector_id
                           where r.print_device_id = d.id and r.route_type = 'production_sector'), '[]'::jsonb),
      'documents', coalesce((select jsonb_agg(r.route_type order by r.route_type) from public.print_device_routes r
                             where r.print_device_id = d.id and r.route_type in ('customer_bill', 'payment_receipt', 'cash_closing')), '[]'::jsonb)
    ) order by d.created_at, d.id)
    from public.print_devices d
    where d.company_id = v_agent.company_id and d.is_active
  ), '[]'::jsonb);
end;
$$;

-- Vincula (ou troca a impressora física de) uma impressora lógica da MESMA empresa a este agente.
-- Impressora já vinculada a outro computador: recusa (desvincule no painel antes).
create function public.bind_print_device(p_agent_id uuid, p_token text, p_print_device_id uuid, p_windows_printer_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_device public.print_devices;
  v_name text := btrim(coalesce(p_windows_printer_name, ''));
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  if char_length(v_name) not between 1 and 200 then
    raise exception 'Selecione a impressora do Windows.' using errcode = 'PT400';
  end if;

  select * into v_device from public.print_devices
  where id = p_print_device_id and company_id = v_agent.company_id for update;
  if not found then
    raise exception 'Impressora não encontrada.' using errcode = 'PT404';
  end if;
  if not v_device.is_active then
    raise exception 'Esta impressora foi removida.' using errcode = 'PT409';
  end if;
  if v_device.agent_id is not null and v_device.agent_id <> v_agent.id then
    raise exception 'Esta impressora já está vinculada a outro computador. Desvincule-a no painel antes.' using errcode = 'PT409';
  end if;

  update public.print_devices
     set agent_id = v_agent.id, windows_printer_name = v_name, bound_at = now()
   where id = v_device.id
  returning * into v_device;

  return jsonb_build_object('ok', true, 'id', v_device.id, 'name', v_device.name,
                            'windows_printer_name', v_device.windows_printer_name, 'is_ready', v_device.is_ready);
end;
$$;

-- CLAIM atômico (ver cabeçalho).
create function public.claim_print_jobs(p_agent_id uuid, p_token text, p_limit integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
  v_result jsonb;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  update public.print_agents set last_seen_at = now() where id = v_agent.id;

  -- Claim esquecido por ESTE agente: não volta para a fila (evita impressão dupla); vira erro visível.
  update public.print_jobs
     set status = 'error',
         error_message = 'Tempo de impressão esgotado. Confira se o papel saiu antes de reimprimir.'
   where company_id = v_agent.company_id
     and claimed_by_agent_id = v_agent.id
     and status = 'claimed'
     and claimed_at < now() - public.print_claim_timeout();

  with picked as (
    select j.id
    from public.print_jobs j
    join public.print_devices d on d.company_id = j.company_id and d.id = j.print_device_id
    where j.company_id = v_agent.company_id
      and j.status = 'pending'
      and d.agent_id = v_agent.id
      and d.is_ready
    order by j.created_at, j.id
    limit v_limit
    for update of j skip locked
  ), upd as (
    update public.print_jobs j
       set status = 'claimed', attempts = j.attempts + 1, claimed_at = now(),
           claimed_by_agent_id = v_agent.id, error_message = null
      from picked
     where j.id = picked.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'job_type', u.job_type, 'attempts', u.attempts, 'created_at', u.created_at,
           'reprint_of_id', u.reprint_of_id, 'payload', u.payload,
           'print_device_id', d.id, 'device_name', d.name, 'paper_width', d.paper_width,
           'windows_printer_name', d.windows_printer_name,
           'escpos_profile', d.escpos_profile, 'escpos_codepage', d.escpos_codepage, 'cut_mode', d.cut_mode
         ) order by u.created_at, u.id), '[]'::jsonb)
    into v_result
  from upd u
  join public.print_devices d on d.company_id = u.company_id and d.id = u.print_device_id;

  return v_result;
end;
$$;

create function public.complete_print_job(p_agent_id uuid, p_token text, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_job public.print_jobs;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  select * into v_job from public.print_jobs where id = p_job_id and company_id = v_agent.company_id for update;
  if not found then
    raise exception 'Job não encontrado.' using errcode = 'PT404';
  end if;
  if v_job.claimed_by_agent_id is distinct from v_agent.id then
    raise exception 'Este job não pertence a este agente.' using errcode = 'PT403';
  end if;
  if v_job.status = 'printed' then
    return jsonb_build_object('ok', true, 'status', 'printed', 'already', true);
  end if;
  if v_job.status <> 'claimed' then
    raise exception 'Este job não está em impressão (status: %).', v_job.status using errcode = 'PT409';
  end if;
  update public.print_jobs set status = 'printed', printed_at = now(), error_message = null where id = v_job.id;
  return jsonb_build_object('ok', true, 'status', 'printed', 'already', false);
end;
$$;

create function public.fail_print_job(p_agent_id uuid, p_token text, p_job_id uuid, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent public.print_agents;
  v_job public.print_jobs;
begin
  v_agent := public.print_agent_auth(p_agent_id, p_token);
  select * into v_job from public.print_jobs where id = p_job_id and company_id = v_agent.company_id for update;
  if not found then
    raise exception 'Job não encontrado.' using errcode = 'PT404';
  end if;
  if v_job.claimed_by_agent_id is distinct from v_agent.id then
    raise exception 'Este job não pertence a este agente.' using errcode = 'PT403';
  end if;
  if v_job.status <> 'claimed' then
    raise exception 'Este job não está em impressão (status: %).', v_job.status using errcode = 'PT409';
  end if;
  update public.print_jobs
     set status = 'error', error_message = left(coalesce(nullif(btrim(p_error), ''), 'Falha na impressão.'), 500)
   where id = v_job.id;
  return jsonb_build_object('ok', true, 'status', 'error');
end;
$$;

-- As RPCs do agente são chamadas SEM sessão de usuário (anon + token).
revoke execute on function public.pair_print_agent(text, text, text) from public;
revoke execute on function public.print_agent_heartbeat(uuid, text) from public;
revoke execute on function public.list_agent_print_devices(uuid, text) from public;
revoke execute on function public.bind_print_device(uuid, text, uuid, text) from public;
revoke execute on function public.claim_print_jobs(uuid, text, integer) from public;
revoke execute on function public.complete_print_job(uuid, text, uuid) from public;
revoke execute on function public.fail_print_job(uuid, text, uuid, text) from public;
grant execute on function public.pair_print_agent(text, text, text) to anon, authenticated, service_role;
grant execute on function public.print_agent_heartbeat(uuid, text) to anon, authenticated, service_role;
grant execute on function public.list_agent_print_devices(uuid, text) to anon, authenticated, service_role;
grant execute on function public.bind_print_device(uuid, text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.claim_print_jobs(uuid, text, integer) to anon, authenticated, service_role;
grant execute on function public.complete_print_job(uuid, text, uuid) to anon, authenticated, service_role;
grant execute on function public.fail_print_job(uuid, text, uuid, text) to anon, authenticated, service_role;
