-- Fase 4: CICLO DE INADIMPLÊNCIA, AUTOMAÇÃO E PERÍODO GRÁTIS (sem gateway externo).
--
-- competência -> geração -> vencimento -> overdue -> carência -> restricted
-- -> pagamento -> active. Toda decisão é derivada das FATURAS no banco; nada
-- vem do frontend. O agendamento (pg_cron) fica na migration seguinte
-- (20260924100000), para que esta lógica seja testável em qualquer Postgres.
--
-- Fora do escopo: Asaas/PIX/webhook, entitlements e read-only reais no /app
-- (aqui só o status `restricted` fica correto no backend e o período grátis
-- fica consultável em tempo real), prorrata, juros, multa, desconto,
-- impostos, notificações, checkout público.
--
-- ===========================================================================
-- REGRAS
--
-- 1. DATA COMERCIAL: business_date() = data de business_now() em
--    America/Sao_Paulo (independe do timezone da sessão). Os testes simulam
--    datas substituindo business_now() no banco descartável; em produção é now().
--
-- 2. JANELA POR VENCIMENTO D (due_date da fatura), sendo hoje = business_date():
--      hoje <= D          : operação normal (fatura open)
--      D+1 .. D+3         : fatura OVERDUE, assinatura em CARÊNCIA (grace),
--                           escrita liberada (3 dias completos de carência)
--      hoje >= D+4        : assinatura RESTRICTED (leitura mantida)
--    grace_until = D+3 (último dia com operação normal);
--    restriction_from = D+4.
--
-- 3. VÁRIAS FATURAS: vale a mais ANTIGA MENSALIDADE em aberto vencida (recurring,
--    open/overdue com due_date < hoje). Ela determina o pior estado (grace ou
--    restricted). A assinatura só volta a `active` quando NÃO resta nenhuma
--    mensalidade vencida. A cobrança INICIAL nunca entra nessa conta: assinatura
--    que não foi ativada não está no ciclo de inadimplência (regra 5h).
--
-- 4. FATURAS: reconcile marca open -> overdue quando hoje > due_date
--    (idempotente, evento `overdue` em invoice_events). paid/void nunca mudam.
--
-- 5. STATUS DA ASSINATURA E MODO MANUAL. Nova coluna status_source:
--      'billing' = status definido pela automação financeira;
--      'manual'  = status definido pelo Master (ou o padrão da contratação).
--    A automação de carência/restrição SÓ mexe em assinaturas active / past_due /
--    grace / restricted:
--      * pending_payment só sai desse estado pelo pagamento da cobrança inicial
--        (regra 5d); suspended e canceled NUNCA são alterados por ela
--        (suspended é ação administrativa; canceled é definitivo). O valor
--        legado `trialing` (status manual anterior a esta migration) também
--        nunca é tocado: o período grátis passou a ser company_trials (regra 5e),
--        não um status de assinatura;
--      * status com source='billing' seguem a dívida em ambas as direções
--        (inclusive voltar a active quando a dívida some);
--      * status com source='manual' só SOBEM (active < past_due < grace <
--        restricted) — a automação nunca desfaz um bloqueio administrativo
--        (ex.: restricted manual) e respeita grace manual com grace_until ainda
--        vigente (prorrogação concedida pelo Master).
--    Mudança manual de status marca source='manual' e roda a reconciliação: se
--    houver dívida vencida, ela reaplica a restrição correspondente — para
--    liberar, quite ou anule a fatura. past_due não é usado pela automação
--    (a carência já cobre D+1..D+3); permanece como rótulo manual.
--
-- 5b. COBRANÇA INICIAL DA CONTRATAÇÃO (sem mês grátis, sem prorrata).
--    Contratar (master_subscribe_company) cria NA MESMA TRANSAÇÃO uma fatura
--    kind='initial': valor INTEGRAL = plano (snapshot) + extras contratados
--    (calculado no banco), vencimento = a DATA da contratação em São Paulo.
--    A assinatura nasce em status `pending_payment` (contratada, ainda NÃO
--    liberada comercialmente; o bloqueio real no /app é da fase de
--    entitlements). O pagamento da inicial leva a assinatura a `active`
--    (origem billing) — feito pela reconciliação, na mesma transação da baixa.
--    A automação de carência/restrição não age em pending_payment; a inicial
--    não paga apenas vira overdue. Inicial não paga fica pendente até o Master
--    agir (sem expiração automática); anular a inicial NÃO cancela nem ativa.
--    A contratação NÃO escolhe status nem billing_day: nasce sempre em
--    pending_payment (o teste grátis é outro fluxo: regra 5e).
--
-- 5c. ÂNCORA DO VENCIMENTO. billing_day = DIA DA CONTRATAÇÃO PAGA em São Paulo
--    (1..31), fixo — o dia em que master_subscribe_company cria a assinatura
--    com a cobrança inicial (vinda de teste grátis ou não; início e fim do
--    período grátis NUNCA participam). A 1ª mensalidade recorrente vence no
--    MESMO DIA do mês SEGUINTE (competência = mês da contratação + 1); dia
--    inexistente usa o último dia do mês SEM perder a âncora (billing_day 31 ->
--    28/02, depois 31/03). Ex.: 12/09 -> 12/10; 24/09 -> 24/10; 31/01 -> 28/02
--    -> 31/03. Assim a inicial ocupa a competência do mês da contratação e as
--    recorrentes começam no mês seguinte: a UNIQUE(subscription_id, competence)
--    continua valendo e nunca há conflito. O intervalo entre cobranças é de 28 a
--    31 dias. Pagamento (mesmo tardio), ciclo, troca de plano e mudança de
--    status NÃO alteram billing_day: não existe alteração automática da âncora.
--    A ÚNICA forma de mudá-la é o ajuste EXCEPCIONAL e explícito do Master,
--    master_set_billing_day: nunca toca fatura já gerada nem recalcula a
--    cobrança inicial, vale pela regra de vigência da fase 3 (primeira
--    competência ainda não faturada) e grava subscription_event
--    `billing_day_changed` com valor anterior, novo, competência de vigência e
--    autor.
--
-- 5d. ATIVAÇÃO SÓ PELO PAGAMENTO DA INICIAL. Uma assinatura com cobrança inicial
--    NÃO paga (open/overdue/void) não entra em active/past_due/grace/restricted
--    por nenhum caminho manual: master_set_subscription_status recusa (inclusive
--    pending_payment -> suspended -> active) e um trigger em subscriptions
--    impede o mesmo por SQL direto. Saindo de pending_payment exige-se a inicial
--    EXISTENTE e paga (o banco garante, no commit, que pending_payment sempre
--    tem a inicial). O único caminho é o pagamento da inicial
--    (master_mark_invoice_paid -> reconciliação, mesma transação). Não há
--    cortesia implícita nem pagamento forjado. Inicial vencida (overdue) ou
--    anulada (void) NÃO move a assinatura: ela segue pending_payment — sem
--    past_due/grace/restricted, sem mensalidades (trigger em invoices) e o Master
--    ainda pode cancelá-la (regra 5g; não há reemissão da inicial). Assinaturas
--    sem cobrança inicial (anteriores a esta fase) não são afetadas.
--
-- 5e. PERÍODO GRÁTIS (TRIAL) — 7 dias controlados pelo BACKEND, INDEPENDENTES
--    do catálogo.
--    * Tabela própria company_trials, UMA linha por empresa (UNIQUE(company_id),
--      FK RESTRICT, DELETE e reescrita bloqueados por trigger): é a evidência
--      permanente de que a empresa já usou o teste, mesmo que assinaturas sejam
--      canceladas e recriadas. NÃO é uma assinatura: não tem preço, billing_day,
--      módulos nem faturas — logo não gera cobrança inicial, mensalidade,
--      dívida, carência nem restrição financeira, e a âncora nunca nasce dele.
--    * Início: master_start_trial(company). Elegível = nunca usou o teste E sem
--      assinatura vigente. NÃO consulta o catálogo: funciona com o plano de code
--      'trial' inexistente, inativo, renomeado ou com outro preço, e nenhum outro
--      plano R$ 0 concede teste. A DURAÇÃO vem só de trial_duration_days() (7).
--      O registro de catálogo de code 'trial' ("GRATIS 7 DIAS", apresentação
--      comercial) é apenas RESERVADO: nunca vira assinatura paga (trigger
--      subscriptions_no_trial_plan) e a UI o esconde das listas pagas.
--    * Regra dos 7 dias: trial_ends_at = trial_started_at + 7 dias corridos de
--      calendário em America/Sao_Paulo, na mesma hora local (24/09 15:00 em SP ->
--      01/10 15:00 em SP; trial_end_of; não depende do TimeZone da sessão nem do
--      horário de verão de nenhum fuso). Hoje equivale a +168h porque SP não tem
--      horário de verão. Vigente enquanto agora < trial_ends_at (fim EXCLUSIVO:
--      no instante exato do fim já expirou).
--    * Estados (company_trials.status): trialing -> expired | converted |
--      canceled; expired -> converted. converted e canceled são definitivos.
--      A vigência real NÃO depende do status guardado nem do agendador:
--      trial_effective_state / company_trial_state / company_has_active_trial
--      avaliam trial_ends_at em tempo real (business_now()) — é isso que a fase
--      de entitlements deve consultar. reconcile_expired_trials() (chamada por
--      run_billing_cycle e testável sozinha) só materializa 'expired' e registra
--      o evento; expirar NÃO cria fatura, dívida, cobrança nem plano pago.
--    * Conversão: master_subscribe_company, se a empresa tem teste em andamento
--      (ou expirado e ainda não convertido), marca o teste como 'converted' e
--      cria a contratação paga NOVA na MESMA transação: assinatura pending_payment
--      + versão contratual + módulos + cobrança inicial integral (com itens)
--      vencendo hoje + eventos, com âncora no dia da contratação. Qualquer falha
--      desfaz TUDO. Os dias restantes do teste NÃO continuam valendo: ele termina
--      como 'converted' na hora e não existe estado híbrido teste + pending_payment
--      (o acesso de pending_payment é da futura política de entitlement).
--      Histórico no teste (converted_at, converted_subscription_id — da mesma
--      empresa —, converted_by, converted_via), no evento 'converted' e no evento
--      'subscribed' da assinatura (from_trial). Teste em andamento e assinatura
--      vigente nunca coexistem (constraint trigger diferida).
--
-- 5f. CONTRATO COBRADO CONGELADO ATÉ O PAGAMENTO. A cobrança inicial é um retrato
--    imutável do contrato. Enquanto ela não for paga (pending_payment, ou suspensa
--    antes de pagar) NÃO se pode trocar o plano, alterar os módulos contratados nem
--    ajustar o dia de vencimento (RPCs recusam e triggers repetem a barreira no
--    banco): sem isso dava para pagar a inicial de um plano barato e ativar já um
--    plano mais caro antes da 1ª mensalidade. Para mudar: pagar a inicial (e então
--    alterar, com a vigência por competência de sempre) ou cancelar a assinatura e
--    contratar de novo. Assinaturas sem inicial (legadas) não são afetadas.
--
-- 5g. CANCELAMENTO ANTES DA ATIVAÇÃO. Cancelar uma assinatura que NUNCA foi ativada
--    (pending_payment, ou suspensa antes de pagar) cuja cobrança inicial ainda está
--    open ou overdue ANULA essa inicial (status void) na MESMA transação: a fatura,
--    os itens e todos os snapshots são preservados (nada é apagado); o
--    invoice_event 'voided' registra a causa tipada
--    (subscription_canceled_before_activation, automática, com o status anterior) e
--    o subscription_event do cancelamento traz reason=canceled_before_activation,
--    initial_invoice_voided e initial_invoice_id. É regra do BANCO (trigger em
--    subscriptions): vale para qualquer caminho de cancelamento e falha junto —
--    qualquer erro desfaz tudo, inclusive o cancelamento. É EXCLUSIVA da inicial de
--    contratação nunca ativada: inicial paga ou já anulada e assinatura legada sem
--    inicial não geram nada (nem evento); cancelar assinatura ATIVA nunca anula
--    mensalidades nem dívidas. Recontratar depois cria assinatura, inicial,
--    snapshot e âncora NOVOS (única assinatura vigente); a inicial antiga permanece
--    void no histórico e nunca é reutilizada. O cancelamento trava a inicial antes
--    da assinatura (mesma ordem do pagamento).
--
-- 5h. ESTADOS TIPADOS (insumo da futura autorização; sem texto montado no front).
--    Assinatura: subscriptions.status é o ciclo de vida (pending_payment, active,
--    past_due, grace, restricted, suspended, canceled). debt_state
--    (master_get_billing_state) é OUTRO eixo — a situação da DÍVIDA RECORRENTE — e
--    nunca sugere inadimplência de assinatura não ativada: para ela vale
--    'awaiting_initial_payment' (mesmo com a inicial vencida; o estado da inicial
--    vem à parte em initial_invoice_status / initial_invoice_overdue /
--    initial_days_overdue); 'ok' | 'grace' | 'restricted' só existem para
--    assinatura ativada e vêm apenas das mensalidades. Período grátis:
--    company_trial_state.state (trialing | expired = trial expirado | converted |
--    canceled), em tempo real. Assim são distinguíveis sem ambiguidade: trialing,
--    trial expirado, pending_payment, active, past_due/grace, restricted,
--    suspended e canceled.
--
-- 6. GERAÇÃO AUTOMÁTICA (auto_generate_subscription_invoices): para cada
--    assinatura active/past_due/grace/restricted (não pending_payment/
--    suspended/canceled nem o legado trialing) QUE TENHA cobrança inicial, nas
--    competências do mês atual e do próximo posteriores ao mês da contratação,
--    gera a fatura recorrente quando: (a) ainda não existe;
--    (b) hoje >= due_date - 10 dias
--    (antecedência para a futura cobrança PIX, e sempre dentro da janela
--    "mês atual + 1" da geração). Usa a MESMA generate_subscription_invoice
--    já testada (idempotente, snapshots). Competências mais antigas que o mês
--    atual não são geradas automaticamente (ficam a cargo do Master).
--
-- 7. AUDITORIA: transições de fatura em invoice_events (novo tipo `overdue`);
--    transições de assinatura em subscription_events (`status_changed` com
--    source='billing' e reason; `billing_day_changed` do ajuste excepcional;
--    `status_changed` do cancelamento com o resultado sobre a inicial, regra 5g);
--    ciclo de vida do período grátis em company_trial_events (started, expired,
--    converted, canceled — append-only, com autor). Só há evento quando algo
--    muda; repetir a reconciliação não gera eventos. As colunas de autor das
--    tabelas de trial NÃO têm FK de propósito: o registro de auditoria não pode
--    impedir a remoção de um usuário nem perder o id de quem agiu.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Estruturas
-- ---------------------------------------------------------------------------
alter table public.subscriptions
  add column status_source text not null default 'manual'
    check (status_source in ('manual', 'billing'));

-- Novo status: contratada e aguardando o pagamento inicial. `trialing` segue
-- aceito só para não invalidar linhas legadas (status manual anterior a esta
-- migration): nenhuma RPC o define mais; o período grátis é company_trials.
alter table public.subscriptions drop constraint subscriptions_status_check;
alter table public.subscriptions add constraint subscriptions_status_check
  check (status in ('pending_payment','trialing','active','past_due','grace','restricted','suspended','canceled'));

-- Cobrança inicial x mensalidade recorrente. A inicial guarda o mês da
-- contratação em competence; recorrentes começam no mês seguinte, então a
-- UNIQUE(subscription_id, competence) existente segue valendo sem conflito.
alter table public.invoices
  add column kind text not null default 'recurring' check (kind in ('initial', 'recurring'));
create unique index invoices_one_initial_per_subscription
  on public.invoices (subscription_id) where kind = 'initial';

alter table public.invoice_events drop constraint invoice_events_event_type_check;
alter table public.invoice_events add constraint invoice_events_event_type_check
  check (event_type in ('generated', 'paid', 'voided', 'overdue'));

-- ---------------------------------------------------------------------------
-- Constantes e data comercial (internas)
-- ---------------------------------------------------------------------------
create function public.business_date()
returns date
language sql
stable
set search_path = public
as $$
  select (public.business_now() at time zone 'America/Sao_Paulo')::date;
$$;

-- Dias completos de carência após o vencimento.
create function public.billing_grace_days()
returns integer
language sql
immutable
set search_path = public
as $$
  select 3;
$$;

-- Antecedência da geração automática em relação ao vencimento.
create function public.billing_invoice_lead_days()
returns integer
language sql
immutable
set search_path = public
as $$
  select 10;
$$;

-- Situação da DÍVIDA RECORRENTE da assinatura, derivada das MENSALIDADES
-- (kind = 'recurring'): a mensalidade mais antiga em aberto e vencida manda. A
-- cobrança INICIAL não conta aqui: uma assinatura que nunca foi ativada
-- (pending_payment) não entra no ciclo de inadimplência (carência/restrição); o
-- vencimento da inicial é informado à parte (master_get_billing_state:
-- initial_invoice_overdue / initial_days_overdue).
create function public.billing_debt_of(p_subscription_id uuid)
returns table (
  state text,
  invoice_id uuid,
  due_date date,
  days_overdue integer,
  grace_until date,
  restriction_from date,
  overdue_count integer
)
language sql
stable
set search_path = public
as $$
  with d as (
    select i.id, i.due_date
    from public.invoices i
    where i.subscription_id = p_subscription_id
      and i.kind = 'recurring'
      and i.status in ('open', 'overdue')
      and i.due_date < public.business_date()
    order by i.due_date, i.competence
    limit 1
  )
  select
    case
      when d.id is null then 'ok'
      when public.business_date() >= d.due_date + (public.billing_grace_days() + 1) then 'restricted'
      else 'grace'
    end,
    d.id,
    d.due_date,
    case when d.id is null then null else public.business_date() - d.due_date end,
    case when d.id is null then null else d.due_date + public.billing_grace_days() end,
    case when d.id is null then null else d.due_date + (public.billing_grace_days() + 1) end,
    (select count(*)::integer from public.invoices i2
      where i2.subscription_id = p_subscription_id
        and i2.kind = 'recurring'
        and i2.status in ('open', 'overdue')
        and i2.due_date < public.business_date())
  from (select 1) one
  left join d on true;
$$;

create function public.billing_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_status
    when 'active' then 0
    when 'past_due' then 1
    when 'grace' then 2
    when 'restricted' then 3
    else null
  end;
$$;

-- ===========================================================================
-- COBRANÇA INICIAL: ATIVAÇÃO SÓ POR PAGAMENTO E CONTRATO COBRADO CONGELADO
-- (regras 5d e 5f)
-- ===========================================================================

-- Cobrança inicial quitada? Verdadeiro quando NÃO existe cobrança inicial
-- (assinaturas anteriores a esta fase, ou a janela DENTRO da própria contratação,
-- antes da fatura ser criada) ou quando ela está paga; open, overdue e void nunca
-- contam como quitada.
create function public.subscription_initial_charge_settled(p_subscription_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select i.status = 'paid'
       from public.invoices i
      where i.subscription_id = p_subscription_id and i.kind = 'initial'),
    true);
$$;

-- Versão ESTRITA: a cobrança inicial existe E está paga. É o critério para SAIR de
-- pending_payment (a ausência da inicial nunca libera uma assinatura aguardando).
create function public.subscription_initial_charge_paid(p_subscription_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.invoices i
    where i.subscription_id = p_subscription_id and i.kind = 'initial' and i.status = 'paid');
$$;

-- Rede de segurança no banco (a RPC recusa antes, com mensagem clara): nenhum
-- caminho — nem SQL direto — leva uma assinatura de cobrança inicial NÃO paga a
-- um estado liberado. Saindo de pending_payment exige-se a inicial paga (estrito);
-- vindo de outro estado (ex.: suspended), basta não haver inicial pendente. O
-- pagamento da inicial passa aqui com a fatura já paga.
create function public.guard_subscription_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean;
begin
  v_released := case when old.status = 'pending_payment'
                     then public.subscription_initial_charge_paid(new.id)
                     else public.subscription_initial_charge_settled(new.id) end;
  if not v_released then
    raise exception 'a cobrança inicial desta assinatura não está paga: ela só é liberada pelo pagamento da fatura inicial';
  end if;
  return new;
end;
$$;

create trigger subscriptions_guard_activation
  before update of status on public.subscriptions
  for each row
  when (new.status is distinct from old.status
        and new.status in ('active', 'past_due', 'grace', 'restricted'))
  execute function public.guard_subscription_activation();

-- Uma assinatura aguardando pagamento SEMPRE tem a cobrança inicial (criada na
-- mesma transação da contratação). Verificado no COMMIT (diferido): dentro da
-- transação a assinatura nasce antes da fatura. Sem isto, "sem inicial" contaria
-- como "quitada" e liberaria a assinatura.
create function public.check_pending_subscription_has_initial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.subscriptions s
             where s.id = new.id and s.status = 'pending_payment')
     and not exists (select 1 from public.invoices i
                     where i.subscription_id = new.id and i.kind = 'initial') then
    raise exception 'assinatura aguardando pagamento inicial precisa ter a cobrança inicial (criada na mesma transação da contratação)';
  end if;
  return null;
end;
$$;

create constraint trigger subscriptions_pending_has_initial
  after insert or update of status on public.subscriptions
  deferrable initially deferred
  for each row
  when (new.status = 'pending_payment')
  execute function public.check_pending_subscription_has_initial();

-- CONTRATO COBRADO CONGELADO (regra 5f). Enquanto a inicial não for paga (assinatura
-- pending_payment, ou suspensa antes de pagar), plano, preço, dia de vencimento e
-- módulos contratados NÃO mudam: a inicial é um retrato imutável e, sem esta
-- trava, dava para pagar a inicial de um plano barato e ativar já um mais caro
-- antes da 1ª recorrente. Para mudar: pagar a inicial (e então alterar, com
-- vigência) ou cancelar e contratar de novo. Vale para qualquer caminho, inclusive
-- SQL direto; assinaturas sem inicial (legadas) não são afetadas.
create function public.guard_subscription_commercial_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.subscription_initial_charge_settled(new.id) then
    raise exception 'a cobrança inicial desta assinatura não está paga: plano, módulos e dia de vencimento só podem mudar depois do pagamento (ou cancele e contrate de novo)';
  end if;
  return new;
end;
$$;

create trigger subscriptions_guard_commercial_change
  before update of plan_id, plan_price_cents_snapshot, billing_day on public.subscriptions
  for each row
  when (new.plan_id is distinct from old.plan_id
        or new.plan_price_cents_snapshot is distinct from old.plan_price_cents_snapshot
        or new.billing_day is distinct from old.billing_day)
  execute function public.guard_subscription_commercial_change();

-- A composição de módulos entra na mesma trava. Na contratação os módulos são
-- gravados ANTES da fatura inicial existir, por isso passam.
create function public.guard_subscription_modules_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.subscription_initial_charge_settled(new.subscription_id) then
    raise exception 'a cobrança inicial desta assinatura não está paga: plano, módulos e dia de vencimento só podem mudar depois do pagamento (ou cancele e contrate de novo)';
  end if;
  return new;
end;
$$;

create trigger subscription_modules_guard_frozen
  before insert or update on public.subscription_modules
  for each row execute function public.guard_subscription_modules_frozen();

-- Nenhuma MENSALIDADE nasce para uma assinatura cuja inicial não foi paga (nem
-- pela geração manual do Master, nem pela automação, nem por SQL direto): inicial
-- open/overdue/void mantém a assinatura sem recorrência até o pagamento ou o
-- cancelamento.
create function public.guard_recurring_invoice_needs_initial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.subscription_initial_charge_settled(new.subscription_id) then
    raise exception 'a cobrança inicial desta assinatura não está paga: mensalidades só existem depois do pagamento da fatura inicial';
  end if;
  return new;
end;
$$;

create trigger invoices_recurring_needs_initial
  before insert on public.invoices
  for each row
  when (new.kind = 'recurring')
  execute function public.guard_recurring_invoice_needs_initial();

-- ===========================================================================
-- CANCELAMENTO ANTES DA ATIVAÇÃO (regra 5g)
-- ===========================================================================

-- Qual cobrança inicial é anulada quando a assinatura é cancelada? Só a de uma
-- contratação NUNCA ativada (estava pending_payment, ou suspensa antes de pagar)
-- e que ainda espera pagamento (open/overdue). Devolve o id ou NULL. É o critério
-- ÚNICO da regra (usado pelo trigger e pelo evento do cancelamento). Inicial paga,
-- já anulada, ou assinatura legada sem inicial: NULL. Mensalidades (recurring)
-- nunca entram: cancelar assinatura ativa não anula dívida nenhuma.
create function public.initial_invoice_to_void_on_cancel(p_subscription_id uuid, p_from_status text)
returns uuid
language sql
stable
set search_path = public
as $$
  select i.id
  from public.invoices i
  where i.subscription_id = p_subscription_id
    and i.kind = 'initial'
    and i.status in ('open', 'overdue')
    and p_from_status in ('pending_payment', 'suspended');
$$;

-- Anula a cobrança inicial na MESMA transação do cancelamento (qualquer caminho:
-- RPC ou SQL direto). Nada é apagado: a fatura, os itens e os snapshots ficam; só
-- o status vira void, com o invoice_event 'voided' dizendo POR QUÊ (causa tipada +
-- texto). Sem inicial a anular (paga, void, legada) não faz nada e não gera evento.
create function public.void_unpaid_initial_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := public.initial_invoice_to_void_on_cancel(new.id, old.status);
  v_inv public.invoices;
begin
  if v_id is null then
    return null;
  end if;

  select * into v_inv from public.invoices where id = v_id for update;
  if v_inv.status not in ('open', 'overdue') then
    return null; -- foi paga/anulada entre a leitura e o lock: nada a anular
  end if;

  update public.invoices set status = 'void' where id = v_inv.id;
  perform public.record_invoice_event(v_inv.id, 'voided', jsonb_build_object(
    'from_status', v_inv.status,
    'reason', 'contratação cancelada antes da ativação: cobrança inicial anulada automaticamente',
    'cause', 'subscription_canceled_before_activation',
    'automatic', true,
    'invoice_kind', 'initial',
    'subscription_id', new.id,
    'subscription_status_before', old.status,
    'amount_cents', v_inv.amount_cents,
    'due_date', v_inv.due_date));
  return null;
end;
$$;

create trigger subscriptions_void_initial_on_cancel
  after update of status on public.subscriptions
  for each row
  when (new.status = 'canceled' and old.status is distinct from 'canceled')
  execute function public.void_unpaid_initial_on_cancel();

-- ===========================================================================
-- PERÍODO GRÁTIS (regra 5e)
-- ===========================================================================

-- Constantes comerciais controladas pelo backend: nada disto vem de preço, de
-- nome ou de existência de plano, nem do frontend. O período grátis NÃO depende
-- do catálogo: o mecanismo (company_trials) funciona igual com o plano 'trial'
-- inexistente, inativo, renomeado ou com outro preço.
--
-- O único vínculo com o catálogo é PROTETIVO: o registro de catálogo de code
-- 'trial' (apresentação comercial "GRATIS 7 DIAS", R$ 0) é RESERVADO — nunca pode
-- virar assinatura paga (trigger subscriptions_no_trial_plan) e a UI o esconde
-- das listas de contratação/troca. Nada aqui lê, altera ou exige esse registro.
create function public.trial_reserved_plan_code()
returns text
language sql
immutable
set search_path = public
as $$
  select 'trial'::text;
$$;

create function public.trial_duration_days()
returns integer
language sql
immutable
set search_path = public
as $$
  select 7;
$$;

-- Fim do período: N dias corridos de calendário em America/Sao_Paulo, na MESMA
-- HORA LOCAL do início (24/09 15:00 em SP -> 01/10 15:00 em SP; nesse instante já
-- está expirado). A soma é feita em hora local (timestamp SEM fuso), então não
-- depende do TimeZone da sessão nem do horário de verão de nenhum fuso. Como São
-- Paulo não tem horário de verão desde 2019, hoje isto é exatamente início + 168h;
-- se SP voltasse a ter, o período manteria a hora local (167h/169h). Regra
-- isolada nesta função: trocar para "168h exatas" é mudar só esta linha.
create function public.trial_end_of(p_started_at timestamptz, p_days integer)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select ((p_started_at at time zone 'America/Sao_Paulo') + make_interval(days => p_days))
         at time zone 'America/Sao_Paulo';
$$;

-- Estado EFETIVO em tempo real: 'trialing' guardado só vale enquanto agora <
-- trial_ends_at; depois disso é 'expired' mesmo que o agendador ainda não tenha
-- rodado. Estados definitivos passam como estão.
create function public.trial_effective_state(p_status text, p_ends_at timestamptz)
returns text
language sql
stable
set search_path = public
as $$
  select case when p_status = 'trialing' and public.business_now() >= p_ends_at
              then 'expired' else p_status end;
$$;

-- Uma linha por empresa, para sempre: é a evidência de que o teste foi usado.
create table public.company_trials (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: a evidência não some com a empresa (o tenant não consegue apagar
  -- e recriar a mesma empresa para ganhar outro período grátis).
  company_id uuid not null references public.companies(id) on delete restrict,
  -- Sem referência a plano de propósito: o período grátis não depende do catálogo.
  status text not null default 'trialing'
    check (status in ('trialing', 'expired', 'converted', 'canceled')),
  trial_started_at timestamptz not null,
  -- Sempre derivado por trigger de trial_started_at + trial_days (trial_end_of).
  trial_ends_at timestamptz not null,
  -- Duração aplicada a ESTE teste (evidência: mudar a constante depois não
  -- reescreve testes antigos).
  trial_days smallint not null check (trial_days > 0),
  -- Autores sem FK de propósito (ver regra 7 do cabeçalho).
  started_by uuid,
  converted_at timestamptz,
  converted_subscription_id uuid,
  converted_by uuid,
  converted_via text,
  canceled_at timestamptz,
  canceled_by uuid,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_trials_one_per_company unique (company_id),
  -- A assinatura da conversão TEM que ser da mesma empresa do teste (RESTRICT: o
  -- vínculo histórico não some com a assinatura). Só vale quando preenchida.
  constraint company_trials_conversion_fk foreign key (converted_subscription_id, company_id)
    references public.subscriptions (id, company_id) on delete restrict,
  constraint company_trials_window_check check (trial_ends_at > trial_started_at),
  constraint company_trials_converted_check check (
    (status = 'converted'
       and converted_at is not null and converted_subscription_id is not null
       and converted_via is not null)
    or (status <> 'converted'
       and converted_at is null and converted_subscription_id is null
       and converted_by is null and converted_via is null)),
  constraint company_trials_canceled_check check (
    (status = 'canceled' and canceled_at is not null)
    or (status <> 'canceled'
       and canceled_at is null and canceled_by is null and cancel_reason is null))
);

create index company_trials_running_idx
  on public.company_trials (trial_ends_at) where status = 'trialing';
create index company_trials_subscription_idx
  on public.company_trials (converted_subscription_id) where converted_subscription_id is not null;

-- Auditoria do período grátis: append-only, com autor. `seq` ordena eventos
-- gravados na MESMA transação (created_at é igual entre eles).
create table public.company_trial_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  trial_id uuid not null references public.company_trials(id) on delete restrict,
  event_type text not null check (event_type in ('started', 'expired', 'converted', 'canceled')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create index company_trial_events_trial_idx on public.company_trial_events (trial_id, seq);

-- Nasce sempre em 'trialing' e o fim é SEMPRE derivado do início e da duração:
-- nenhum chamador consegue gravar um fim diferente.
create function public.set_company_trial_window()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'trialing' then
    raise exception 'o período grátis nasce em trialing';
  end if;
  new.trial_ends_at := public.trial_end_of(new.trial_started_at, new.trial_days);
  return new;
end;
$$;

-- Histórico protegido no banco (não só nas RPCs): não se apaga, os dados do
-- período são imutáveis e o estado só avança pelas transições válidas:
--   trialing -> expired | converted | canceled;  expired -> converted.
-- converted e canceled são definitivos. 'expired' só depois do fim e cancelar
-- só antes dele.
create function public.guard_company_trial_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'o histórico do período grátis não pode ser apagado';
  end if;

  if old.status in ('converted', 'canceled') then
    raise exception 'período grátis % é definitivo e não pode ser alterado', old.status;
  end if;

  if new.id is distinct from old.id
     or new.company_id is distinct from old.company_id
     or new.trial_started_at is distinct from old.trial_started_at
     or new.trial_ends_at is distinct from old.trial_ends_at
     or new.trial_days is distinct from old.trial_days
     or new.started_by is distinct from old.started_by
     or new.created_at is distinct from old.created_at then
    raise exception 'dados do período grátis são imutáveis';
  end if;

  if new.status = old.status then
    if (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
      raise exception 'o período grátis só muda por transição de estado';
    end if;
    return new;
  end if;

  if not ((old.status = 'trialing' and new.status in ('expired', 'converted', 'canceled'))
          or (old.status = 'expired' and new.status = 'converted')) then
    raise exception 'transição inválida do período grátis: % -> %', old.status, new.status;
  end if;
  if new.status = 'expired' and public.business_now() < old.trial_ends_at then
    raise exception 'o período grátis ainda não terminou';
  end if;
  if new.status = 'canceled' and public.business_now() >= old.trial_ends_at then
    raise exception 'o período grátis já terminou: não há o que cancelar';
  end if;
  return new;
end;
$$;

create function public.prevent_company_trial_event_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'company_trial_events é append-only';
end;
$$;

create trigger company_trials_set_window
  before insert on public.company_trials
  for each row execute function public.set_company_trial_window();
create trigger company_trials_guard
  before update or delete on public.company_trials
  for each row execute function public.guard_company_trial_change();
create trigger company_trials_set_updated_at
  before update on public.company_trials
  for each row execute function public.set_updated_at();
create trigger company_trial_events_no_change
  before update or delete on public.company_trial_events
  for each row execute function public.prevent_company_trial_event_change();

-- Teste em andamento e assinatura vigente são MUTUAMENTE EXCLUSIVOS. Verificado
-- no COMMIT (diferido) para que a conversão possa, na mesma transação, criar a
-- assinatura e marcar o teste como convertido em qualquer ordem.
create function public.check_trial_subscription_exclusive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.company_trials t
             where t.company_id = new.company_id and t.status = 'trialing')
     and exists (select 1 from public.subscriptions s
                 where s.company_id = new.company_id and s.status <> 'canceled') then
    raise exception 'a empresa não pode ter período grátis em andamento e assinatura vigente ao mesmo tempo';
  end if;
  return null;
end;
$$;

create constraint trigger company_trials_exclusive
  after insert or update of status on public.company_trials
  deferrable initially deferred
  for each row
  when (new.status = 'trialing')
  execute function public.check_trial_subscription_exclusive();
create constraint trigger subscriptions_trial_exclusive
  after insert or update of status on public.subscriptions
  deferrable initially deferred
  for each row
  when (new.status <> 'canceled')
  execute function public.check_trial_subscription_exclusive();

-- O registro de catálogo reservado (code 'trial': apresentação comercial) NÃO pode
-- virar assinatura (nem por contratação, nem por troca de plano). Sem isto,
-- escolher o plano R$ 0 no fluxo pago criaria um "grátis" sem prazo. É só uma
-- proteção do registro: se ele não existir, nada acontece e o período grátis
-- segue funcionando. Assinaturas legadas que já estejam nele não são tocadas.
create function public.guard_subscription_plan_not_trial()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.plan_id = old.plan_id then
    return new;
  end if;
  if exists (select 1 from public.plans p
             where p.id = new.plan_id and p.code = public.trial_reserved_plan_code()) then
    raise exception 'o plano de teste não pode ser contratado como assinatura: o período grátis tem fluxo próprio';
  end if;
  return new;
end;
$$;

create trigger subscriptions_no_trial_plan
  before insert or update of plan_id on public.subscriptions
  for each row execute function public.guard_subscription_plan_not_trial();

-- RLS ativo, sem policies, sem grants para clientes (como as demais tabelas
-- comerciais): o tenant não enxerga nem altera o teste.
alter table public.company_trials enable row level security;
alter table public.company_trial_events enable row level security;

revoke all on public.company_trials from anon, authenticated;
revoke all on public.company_trial_events from anon, authenticated;

create function public.record_company_trial_event(
  p_trial_id uuid,
  p_event_type text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.company_trial_events (trial_id, event_type, payload, actor_id)
  values (p_trial_id, p_event_type, coalesce(p_payload, '{}'::jsonb), auth.uid());
end;
$$;

-- Respostas DETERMINÍSTICAS e em tempo real (não dependem do agendador): já
-- usou? vigente? quando termina? já terminou? É a fonte que a fase de
-- entitlements deve consultar.
create function public.company_trial_state(p_company_id uuid)
returns table (
  has_used_trial boolean,
  trial_id uuid,
  state text,
  is_active boolean,
  has_ended boolean,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_days smallint
)
language sql
stable
set search_path = public
as $$
  select
    t.id is not null,
    t.id,
    coalesce(public.trial_effective_state(t.status, t.trial_ends_at), 'none'),
    coalesce(public.trial_effective_state(t.status, t.trial_ends_at) = 'trialing', false),
    coalesce(public.trial_effective_state(t.status, t.trial_ends_at) <> 'trialing', false),
    t.trial_started_at,
    t.trial_ends_at,
    t.trial_days
  from (select 1) one
  left join public.company_trials t on t.company_id = p_company_id;
$$;

-- Atalho para o caminho quente da autorização futura.
create function public.company_has_active_trial(p_company_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.company_trials t
    where t.company_id = p_company_id
      and t.status = 'trialing'
      and public.business_now() < t.trial_ends_at);
$$;

-- Materializa a expiração de UMA empresa (idempotente; só há evento quando o
-- estado muda). Não cria fatura, dívida, cobrança nem plano pago.
create function public.reconcile_company_trial(p_company_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t public.company_trials;
  v_now timestamptz := public.business_now();
begin
  select * into v_t from public.company_trials where company_id = p_company_id for update;
  if not found or v_t.status <> 'trialing' or v_now < v_t.trial_ends_at then
    return false;
  end if;

  update public.company_trials set status = 'expired' where id = v_t.id;
  perform public.record_company_trial_event(v_t.id, 'expired', jsonb_build_object(
    'trial_started_at', v_t.trial_started_at,
    'trial_ends_at', v_t.trial_ends_at,
    'reconciled_at', v_now,
    'flow', 'reconcile'));
  return true;
end;
$$;

-- Função do agendador: expira todos os testes vencidos. Devolve quantos.
create function public.reconcile_expired_trials()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r record;
  v_n integer := 0;
begin
  for v_r in
    select t.company_id from public.company_trials t
    where t.status = 'trialing' and t.trial_ends_at <= public.business_now()
    order by t.trial_ends_at, t.id
  loop
    if public.reconcile_company_trial(v_r.company_id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Visão do Master sobre o teste de UMA empresa (derivada, em tempo real).
create function public.company_trial_json(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_t public.company_trials;
  v_state text;
  v_can_start boolean;
begin
  select * into v_t from public.company_trials where company_id = p_company_id;

  v_state := case when v_t.id is null then 'none'
                  else public.trial_effective_state(v_t.status, v_t.trial_ends_at) end;
  -- Elegibilidade NÃO consulta o catálogo: nunca usou E sem assinatura vigente.
  v_can_start := v_t.id is null
    and not exists (select 1 from public.subscriptions s
                    where s.company_id = p_company_id and s.status <> 'canceled');

  return jsonb_build_object(
    'state', v_state,
    'has_used_trial', v_t.id is not null,
    'is_active', v_state = 'trialing',
    'has_ended', v_t.id is not null and v_state <> 'trialing',
    'can_start', v_can_start,
    'offer_days', public.trial_duration_days(),
    -- code do registro de catálogo reservado (a UI o esconde das listas pagas);
    -- é só um código: o registro pode nem existir.
    'reserved_plan_code', public.trial_reserved_plan_code(),
    'trial_id', v_t.id,
    'trial_started_at', v_t.trial_started_at,
    'trial_ends_at', v_t.trial_ends_at,
    'trial_started_on', (v_t.trial_started_at at time zone 'America/Sao_Paulo')::date,
    'trial_ends_on', (v_t.trial_ends_at at time zone 'America/Sao_Paulo')::date,
    'trial_days', v_t.trial_days,
    'converted_at', v_t.converted_at,
    'converted_subscription_id', v_t.converted_subscription_id,
    'converted_via', v_t.converted_via,
    'canceled_at', v_t.canceled_at,
    'cancel_reason', v_t.cancel_reason,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'payload', e.payload,
        'created_at', e.created_at, 'actor_email', pr.email
      ) order by e.seq)
      from public.company_trial_events e
      left join public.profiles pr on pr.user_id = e.actor_id
      where e.trial_id = v_t.id
    ), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliação (idempotente): fatura -> overdue e assinatura -> estado
-- financeiro. Trava a assinatura (mesmo lock das demais operações).
-- ---------------------------------------------------------------------------
create function public.reconcile_subscription_billing_state(p_subscription_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_today date := public.business_date();
  v_inv record;
  v_flipped integer := 0;
  v_debt record;
  v_target text;
  v_from text;
  v_apply boolean := false;
  v_initial_id uuid;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    return null;
  end if;
  v_from := v_sub.status;

  -- 1) open -> overdue (vale para qualquer status da assinatura: é fato da fatura)
  for v_inv in
    select id, due_date from public.invoices
    where subscription_id = p_subscription_id and status = 'open' and due_date < v_today
    order by due_date, competence
  loop
    update public.invoices set status = 'overdue' where id = v_inv.id and status = 'open';
    if found then
      perform public.record_invoice_event(v_inv.id, 'overdue', jsonb_build_object(
        'due_date', v_inv.due_date, 'business_date', v_today,
        'days_overdue', v_today - v_inv.due_date));
      v_flipped := v_flipped + 1;
    end if;
  end loop;

  -- 1b) cobrança inicial paga libera a assinatura (pending_payment -> active)
  if v_sub.status = 'pending_payment' then
    select id into v_initial_id from public.invoices
    where subscription_id = p_subscription_id and kind = 'initial' and status = 'paid';
    if v_initial_id is not null then
      update public.subscriptions
      set status = 'active', grace_until = null, status_source = 'billing'
      where id = v_sub.id
      returning * into v_sub;
      perform public.record_subscription_event(v_sub.id, 'status_changed', jsonb_build_object(
        'from', 'pending_payment', 'to', 'active', 'source', 'billing',
        'reason', 'initial_payment', 'invoice_id', v_initial_id));
    end if;
  end if;

  select * into v_debt from public.billing_debt_of(p_subscription_id);

  -- 2) só active/past_due/grace/restricted são geridos pela automação
  if v_sub.status in ('active', 'past_due', 'grace', 'restricted') then
    v_target := case v_debt.state when 'ok' then 'active' else v_debt.state end;

    if v_target <> v_sub.status then
      if v_sub.status_source = 'billing' then
        v_apply := true;
      else
        -- manual: só escalona, e respeita prorrogação de carência ainda vigente
        v_apply := public.billing_status_rank(v_target) > public.billing_status_rank(v_sub.status)
          and not (v_sub.status = 'grace' and v_sub.grace_until is not null
                   and v_sub.grace_until >= v_today);
      end if;
    end if;

    if v_apply then
      update public.subscriptions
      set status = v_target,
          grace_until = case when v_target = 'grace' then v_debt.grace_until end,
          status_source = 'billing'
      where id = v_sub.id
      returning * into v_sub;

      perform public.record_subscription_event(v_sub.id, 'status_changed', jsonb_build_object(
        'from', v_from, 'to', v_target, 'source', 'billing',
        'reason', case v_target
                    when 'active' then 'debt_settled'
                    when 'grace' then 'invoice_overdue'
                    else 'grace_period_ended' end,
        'invoice_id', v_debt.invoice_id, 'due_date', v_debt.due_date,
        'grace_until', v_sub.grace_until, 'restriction_from', v_debt.restriction_from));
    elsif v_sub.status_source = 'billing' and v_sub.status = 'grace'
          and v_sub.grace_until is distinct from v_debt.grace_until then
      -- a fatura mais antiga mudou (ex.: a mais velha foi paga): atualiza a data
      update public.subscriptions set grace_until = v_debt.grace_until where id = v_sub.id
      returning * into v_sub;
    end if;
  end if;

  return jsonb_build_object(
    'subscription_id', v_sub.id,
    'invoices_marked_overdue', v_flipped,
    'status_from', v_from,
    'status_to', v_sub.status,
    'debt_state', v_debt.state);
end;
$$;

-- ---------------------------------------------------------------------------
-- Geração automática
-- ---------------------------------------------------------------------------
create function public.auto_generate_subscription_invoices(p_subscription_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_today date := public.business_date();
  v_cur date := public.competence_of(public.business_now());
  v_c date;
  v_terms public.subscription_terms;
  v_due date;
  v_res jsonb;
  v_created integer := 0;
  n integer;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found or v_sub.status not in ('active', 'past_due', 'grace', 'restricted') then
    return 0;
  end if;
  -- só assinaturas contratadas com cobrança inicial entram na recorrência automática
  if not exists (select 1 from public.invoices
                 where subscription_id = p_subscription_id and kind = 'initial') then
    return 0;
  end if;

  for n in 0..1 loop
    v_c := (v_cur + make_interval(months => n))::date;
    if v_c <= public.competence_of(v_sub.started_at) then
      continue; -- o mês da contratação é coberto pela cobrança inicial
    end if;
    v_terms := public.subscription_terms_at(p_subscription_id, v_c);
    if v_terms.id is null then
      continue;
    end if;
    v_due := public.invoice_due_date(v_c, v_terms.billing_day);
    if v_today < v_due - public.billing_invoice_lead_days() then
      continue; -- ainda cedo para esta competência
    end if;
    if exists (select 1 from public.invoices where subscription_id = p_subscription_id and competence = v_c) then
      continue;
    end if;
    v_res := public.generate_subscription_invoice(p_subscription_id, v_c);
    if (v_res ->> 'created')::boolean then
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

-- Ciclo diário: gera faturas elegíveis, reconcilia TODAS as assinaturas e
-- expira períodos grátis vencidos. Uma assinatura (ou a etapa de trials) com
-- erro não derruba as demais (o erro é contado e avisado). A expiração do teste
-- aqui é só bookkeeping: a vigência real é avaliada em tempo real (regra 5e).
create function public.run_billing_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_generated integer := 0;
  v_overdue integer := 0;
  v_changes integer := 0;
  v_trials integer := 0;
  v_errors integer := 0;
  v_r jsonb;
begin
  for v_sub in select id from public.subscriptions order by created_at, id loop
    begin
      v_generated := v_generated + public.auto_generate_subscription_invoices(v_sub.id);
      v_r := public.reconcile_subscription_billing_state(v_sub.id);
      v_overdue := v_overdue + coalesce((v_r ->> 'invoices_marked_overdue')::integer, 0);
      if v_r ->> 'status_from' is distinct from v_r ->> 'status_to' then
        v_changes := v_changes + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'run_billing_cycle: assinatura % falhou: %', v_sub.id, sqlerrm;
    end;
  end loop;

  begin
    v_trials := public.reconcile_expired_trials();
  exception when others then
    v_errors := v_errors + 1;
    raise warning 'run_billing_cycle: expiração de períodos grátis falhou: %', sqlerrm;
  end;

  return jsonb_build_object(
    'business_date', public.business_date(),
    'invoices_generated', v_generated,
    'invoices_marked_overdue', v_overdue,
    'status_changes', v_changes,
    'trials_expired', v_trials,
    'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- Integração com as RPCs existentes (mesma transação)
-- ---------------------------------------------------------------------------
create or replace function public.master_mark_invoice_paid(
  p_invoice_id uuid,
  p_paid_at timestamptz default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_paid timestamptz;
  v_from text;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  if v_inv.status = 'paid' then
    if p_paid_at is null or p_paid_at = v_inv.paid_at then
      return v_inv;
    end if;
    raise exception 'fatura já paga em %', v_inv.paid_at;
  end if;
  if v_inv.status = 'void' then
    raise exception 'fatura anulada não pode ser paga';
  end if;

  v_paid := coalesce(p_paid_at, now());
  if v_paid > now() + interval '5 minutes' then
    raise exception 'data de pagamento não pode ser futura';
  end if;

  v_from := v_inv.status;
  update public.invoices set status = 'paid', paid_at = v_paid
  where id = v_inv.id returning * into v_inv;

  perform public.record_invoice_event(v_inv.id, 'paid', jsonb_build_object(
    'from_status', v_from, 'paid_at', v_paid, 'amount_cents', v_inv.amount_cents));

  -- a dívida pode ter acabado: reconcilia a assinatura na mesma transação
  perform public.reconcile_subscription_billing_state(v_inv.subscription_id);

  return v_inv;
end;
$$;

create or replace function public.master_void_invoice(p_invoice_id uuid, p_reason text default null)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_from text;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  if v_inv.status = 'void' then
    return v_inv;
  end if;
  if v_inv.status = 'paid' then
    raise exception 'fatura paga não pode ser anulada';
  end if;

  v_from := v_inv.status;
  update public.invoices set status = 'void' where id = v_inv.id returning * into v_inv;

  perform public.record_invoice_event(v_inv.id, 'voided', jsonb_build_object(
    'from_status', v_from, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  -- anular uma fatura vencida também encerra a dívida
  perform public.reconcile_subscription_billing_state(v_inv.subscription_id);

  return v_inv;
end;
$$;

-- Status manual: marca source='manual' e reconcilia (a dívida vencida reaplica
-- a restrição; para liberar, quite ou anule a fatura). NÃO é porta de ativação:
--  * pending_payment é o estado da contratação e trialing (legado) não é mais um
--    status de assinatura — nenhum dos dois é definido manualmente;
--  * com cobrança inicial não paga (open/overdue/void) a assinatura não vai a
--    active/past_due/grace/restricted, direta ou indiretamente (ex.: passando
--    por suspended); só o pagamento da inicial a libera (regra 5d). Saindo de
--    pending_payment exige-se a inicial EXISTENTE e paga. O banco repete essa
--    barreira por trigger;
--  * cancelar uma assinatura NUNCA ativada anula a cobrança inicial em aberto ou
--    vencida na mesma transação (regra 5g); cancelar assinatura ativa não anula
--    nenhuma fatura.
create or replace function public.master_set_subscription_status(
  p_subscription_id uuid,
  p_status text,
  p_grace_until date
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old_status text;
  v_old_grace date;
  v_released boolean;
  v_void_initial uuid;
begin
  perform public.assert_master_admin();

  -- Cancelar pode anular a cobrança inicial (regra 5g). A inicial é travada ANTES da
  -- assinatura, na mesma ordem do pagamento (fatura -> assinatura): cancelar e pagar
  -- a mesma inicial ao mesmo tempo se serializam em vez de travar um ao outro, e o
  -- que o evento registra é exatamente o que o trigger fará.
  if p_status = 'canceled' then
    perform 1 from public.invoices where subscription_id = p_subscription_id and kind = 'initial' for update;
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then
    raise exception 'assinatura cancelada é definitiva; contrate novamente se necessário';
  end if;
  if p_status is null or p_status not in
     ('pending_payment','trialing','active','past_due','grace','restricted','suspended','canceled') then
    raise exception 'status inválido';
  end if;
  if p_grace_until is not null and p_status <> 'grace' then
    raise exception 'grace_until só se aplica ao status grace';
  end if;

  v_old_status := v_sub.status;
  v_old_grace := v_sub.grace_until;
  if v_old_status = p_status and v_old_grace is not distinct from p_grace_until then
    return v_sub;
  end if;

  if p_status = 'pending_payment' then
    raise exception 'aguardando pagamento é o estado da contratação e não pode ser definido manualmente';
  end if;
  if p_status = 'trialing' then
    raise exception 'o período grátis não é um status de assinatura: use o fluxo de período grátis da empresa';
  end if;
  if p_status in ('active', 'past_due', 'grace', 'restricted') then
    v_released := case when v_old_status = 'pending_payment'
                       then public.subscription_initial_charge_paid(v_sub.id)
                       else public.subscription_initial_charge_settled(v_sub.id) end;
    if not v_released then
      raise exception 'a cobrança inicial desta assinatura não está paga: ela só é ativada pelo pagamento da fatura inicial';
    end if;
  end if;

  -- Cancelamento ANTES da ativação (regra 5g): a inicial em aberto/vencida é anulada
  -- pelo trigger, na mesma transação; aqui só se sabe qual (mesmo critério do trigger).
  if p_status = 'canceled' then
    v_void_initial := public.initial_invoice_to_void_on_cancel(v_sub.id, v_old_status);
  end if;

  update public.subscriptions
  set status = p_status,
      grace_until = case when p_status = 'grace' then p_grace_until else null end,
      canceled_at = case when p_status = 'canceled' then now() else null end,
      status_source = 'manual'
  where id = v_sub.id
  returning * into v_sub;

  perform public.record_subscription_event(v_sub.id, 'status_changed', jsonb_build_object(
    'from', v_old_status, 'to', p_status, 'grace_until', v_sub.grace_until, 'source', 'manual'
  ) || case when v_void_initial is null then '{}'::jsonb
            else jsonb_build_object(
              'reason', 'canceled_before_activation',
              'initial_invoice_voided', true,
              'initial_invoice_id', v_void_initial) end);

  if p_status <> 'canceled' then
    perform public.reconcile_subscription_billing_state(v_sub.id);
    select * into v_sub from public.subscriptions where id = v_sub.id;
  end if;

  return v_sub;
end;
$$;

-- Lista com dias em atraso calculados no banco (data comercial).
drop function public.master_list_invoices(uuid, text, date);

create function public.master_list_invoices(
  p_company_id uuid default null,
  p_status text default null,
  p_competence date default null
)
returns table (
  id uuid,
  subscription_id uuid,
  company_id uuid,
  company_name text,
  plan_description text,
  competence date,
  due_date date,
  amount_cents integer,
  status text,
  paid_at timestamptz,
  created_at timestamptz,
  days_overdue integer,
  kind text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  if p_status is not null and p_status not in ('open', 'paid', 'overdue', 'void') then
    raise exception 'status inválido';
  end if;

  return query
  select
    i.id, i.subscription_id, i.company_id, c.name,
    (select it.description from public.invoice_items it
      where it.invoice_id = i.id and it.kind = 'plan' order by it.created_at limit 1),
    i.competence, i.due_date, i.amount_cents, i.status, i.paid_at, i.created_at,
    case when i.status in ('open', 'overdue') and i.due_date < public.business_date()
         then public.business_date() - i.due_date end,
    i.kind
  from public.invoices i
  join public.companies c on c.id = i.company_id
  where (p_company_id is null or i.company_id = p_company_id)
    and (p_status is null or i.status = p_status)
    and (p_competence is null or i.competence = p_competence)
  order by i.competence desc, i.due_date desc, c.name
  limit 500;
end;
$$;

create or replace function public.master_get_invoice(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_result jsonb;
begin
  perform public.assert_master_admin();

  select * into v_inv from public.invoices where id = p_invoice_id;
  if not found then
    raise exception 'fatura não encontrada';
  end if;

  select jsonb_build_object(
    'invoice', to_jsonb(v_inv),
    'company', (select jsonb_build_object('id', c.id, 'name', c.name)
                from public.companies c where c.id = v_inv.company_id),
    'subscription', (select jsonb_build_object(
                       'id', s.id, 'status', s.status, 'billing_day', s.billing_day,
                       'plan_id', s.plan_id, 'status_source', s.status_source,
                       'grace_until', s.grace_until)
                     from public.subscriptions s where s.id = v_inv.subscription_id),
    'billing', jsonb_build_object(
      'business_date', public.business_date(),
      -- só a MENSALIDADE participa do ciclo carência/restrição; a cobrança inicial
      -- vencida não agenda carência nem restrição (a assinatura só aguarda o pagamento)
      'applies_to_debt_cycle', v_inv.kind = 'recurring',
      'days_overdue', case when v_inv.status in ('open', 'overdue') and v_inv.due_date < public.business_date()
                           then public.business_date() - v_inv.due_date end,
      'grace_until', case when v_inv.kind = 'recurring' and v_inv.status in ('open', 'overdue')
                          then v_inv.due_date + public.billing_grace_days() end,
      'restriction_from', case when v_inv.kind = 'recurring' and v_inv.status in ('open', 'overdue')
                               then v_inv.due_date + (public.billing_grace_days() + 1) end),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', it.id, 'kind', it.kind, 'ref_id', it.ref_id,
        'description', it.description, 'amount_cents', it.amount_cents
      ) order by case it.kind when 'plan' then 0 when 'module' then 1 else 2 end,
                 it.description, it.id)
      from public.invoice_items it where it.invoice_id = v_inv.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'payload', e.payload,
        'created_at', e.created_at, 'actor_email', pr.email
      ) order by e.created_at, e.id)
      from public.invoice_events e
      left join public.profiles pr on pr.user_id = e.actor_id
      where e.invoice_id = v_inv.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs novas do Master
-- ---------------------------------------------------------------------------
-- Situação financeira de UMA assinatura, TIPADA (nenhum texto montado no front).
-- Dois eixos que NÃO se misturam:
--  * status: o ciclo de vida guardado (pending_payment, active, past_due, grace,
--    restricted, suspended, canceled);
--  * debt_state: a situação da DÍVIDA RECORRENTE, só para assinatura ATIVADA:
--    'ok' | 'grace' | 'restricted' (vêm apenas das mensalidades). Para a
--    assinatura que nunca foi ativada (pending_payment, ou suspensa antes de pagar)
--    vale SEMPRE 'awaiting_initial_payment' — nunca grace/restricted, nem com a
--    inicial vencida — e os campos do ciclo recorrente (oldest_*, days_overdue,
--    debt_grace_until, restriction_from, overdue_count) ficam vazios. O estado da
--    cobrança inicial vem à parte: initial_invoice_status (open|overdue|paid|void)
--    e, em tempo real, initial_invoice_overdue / initial_days_overdue.
create function public.master_get_billing_state(p_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_debt record;
  v_init public.invoices;
  v_today date := public.business_date();
  v_awaiting boolean;
  v_init_overdue boolean;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if not found then
    raise exception 'assinatura não encontrada';
  end if;
  select * into v_debt from public.billing_debt_of(p_subscription_id);
  select * into v_init from public.invoices where subscription_id = p_subscription_id and kind = 'initial';

  -- nunca ativada: aguardando o pagamento da inicial (a cancelada nada aguarda)
  v_awaiting := v_sub.status <> 'canceled'
    and (v_sub.status = 'pending_payment'
         or not public.subscription_initial_charge_settled(v_sub.id));
  v_init_overdue := v_init.id is not null
    and v_init.status in ('open', 'overdue')
    and v_init.due_date < v_today;

  return jsonb_build_object(
    'business_date', v_today,
    'status', v_sub.status,
    'status_source', v_sub.status_source,
    'grace_until', v_sub.grace_until,
    'debt_state', case when v_awaiting then 'awaiting_initial_payment' else v_debt.state end,
    'oldest_overdue_invoice_id', v_debt.invoice_id,
    'oldest_due_date', v_debt.due_date,
    'days_overdue', v_debt.days_overdue,
    'debt_grace_until', v_debt.grace_until,
    'restriction_from', v_debt.restriction_from,
    'overdue_count', v_debt.overdue_count,
    'initial_invoice_id', v_init.id,
    'initial_invoice_status', v_init.status,
    'initial_invoice_due_date', v_init.due_date,
    'initial_invoice_overdue', v_init_overdue,
    'initial_days_overdue', case when v_init_overdue then v_today - v_init.due_date end);
end;
$$;

-- Execução manual do mesmo ciclo do agendador (operação/validação).
create function public.master_run_billing_cycle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();
  return public.run_billing_cycle();
end;
$$;

-- ---------------------------------------------------------------------------
-- Cobrança inicial (interna, idempotente): valor integral do contrato vigente
-- no mês da contratação; vence na data da contratação (São Paulo).
-- ---------------------------------------------------------------------------
create function public.generate_initial_invoice(p_subscription_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_inv public.invoices;
  v_terms public.subscription_terms;
  v_month date;
  v_total bigint;
  v_items jsonb;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'assinatura não encontrada';
  end if;

  select * into v_inv from public.invoices
  where subscription_id = p_subscription_id and kind = 'initial';
  if found then
    return jsonb_build_object('invoice_id', v_inv.id, 'created', false);
  end if;

  v_month := public.competence_of(v_sub.started_at);
  v_terms := public.subscription_terms_at(p_subscription_id, v_month);
  if v_terms.id is null then
    raise exception 'sem vigência contratual para a cobrança inicial';
  end if;

  select v_terms.plan_price_cents_snapshot + coalesce(sum(e.price_cents), 0)
  into v_total
  from public.subscription_extras_at(p_subscription_id, v_month) e;

  insert into public.invoices (subscription_id, company_id, competence, due_date, amount_cents, kind)
  values (v_sub.id, v_sub.company_id, v_month,
          (v_sub.started_at at time zone 'America/Sao_Paulo')::date, v_total, 'initial')
  returning * into v_inv;

  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  values (v_inv.id, 'plan', v_terms.plan_id, 'Plano ' || v_terms.plan_name_snapshot,
          v_terms.plan_price_cents_snapshot);

  insert into public.invoice_items (invoice_id, kind, ref_id, description, amount_cents)
  select v_inv.id, 'module', e.module_id, 'Módulo ' || e.module_name, e.price_cents
  from public.subscription_extras_at(p_subscription_id, v_month) e;

  select jsonb_agg(jsonb_build_object(
           'kind', it.kind, 'ref_id', it.ref_id,
           'description', it.description, 'amount_cents', it.amount_cents)
         order by case it.kind when 'plan' then 0 else 1 end, it.description, it.id)
  into v_items from public.invoice_items it where it.invoice_id = v_inv.id;

  perform public.record_invoice_event(v_inv.id, 'generated', jsonb_build_object(
    'invoice_kind', 'initial',
    'subscription_id', v_sub.id,
    'competence', v_month,
    'due_date', v_inv.due_date,
    'billing_day', v_sub.billing_day,
    'terms_effective_from', v_terms.effective_from_competence,
    'plan_id', v_terms.plan_id,
    'amount_cents', v_inv.amount_cents,
    'items', v_items));

  return jsonb_build_object('invoice_id', v_inv.id, 'created', true);
end;
$$;

-- Contratação PAGA. Não recebe status nem billing_day: a assinatura nasce em
-- pending_payment e a âncora (billing_day) é o dia desta contratação em São
-- Paulo. Extras entram na cobrança inicial, que é criada aqui, na mesma
-- transação. É também o ponto de CONVERSÃO do período grátis: se a empresa tem
-- teste em andamento (ou expirado e não convertido), ele é encerrado como
-- 'converted' AQUI, com vínculo à nova assinatura — o início e o fim do teste
-- nunca definem vencimento. Substitui a versão anterior (que recebia
-- billing_day/status e não tratava cobrança inicial nem teste).
drop function public.master_subscribe_company(uuid, uuid, integer, text);

create function public.master_subscribe_company(
  p_company_id uuid,
  p_plan_id uuid,
  p_extra_module_ids uuid[] default '{}'::uuid[]
)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_sub public.subscriptions;
  v_mod public.modules;
  v_trial public.company_trials;
  v_now timestamptz := public.business_now();
  v_start date := public.competence_of(public.business_now());
  v_day integer := extract(day from (public.business_now() at time zone 'America/Sao_Paulo'))::integer;
  v_ids uuid[];
  v_id uuid;
  v_initial jsonb;
  v_from_trial jsonb := null;
begin
  perform public.assert_master_admin();

  -- Serializa contratação, início e cancelamento de teste da MESMA empresa
  -- (NO KEY UPDATE não bloqueia os inserts que referenciam a empresa).
  perform 1 from public.companies where id = p_company_id for no key update;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  select * into v_plan from public.plans where id = p_plan_id;
  if not found then
    raise exception 'plano não encontrado';
  end if;
  if not v_plan.is_active then
    raise exception 'plano inativo não pode ser contratado';
  end if;
  -- (o plano de code 'trial' é recusado pelo trigger subscriptions_no_trial_plan)

  if exists (select 1 from public.subscriptions where company_id = p_company_id and status <> 'canceled') then
    raise exception 'a empresa já possui uma assinatura vigente';
  end if;

  v_ids := coalesce(array(select distinct unnest(coalesce(p_extra_module_ids, '{}'::uuid[]))), '{}'::uuid[]);
  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id;
    if not found then raise exception 'módulo inexistente na lista'; end if;
    if not v_mod.is_active then raise exception 'módulo inativo "%" não pode ser contratado', v_mod.name; end if;
    if exists (select 1 from public.plan_modules where plan_id = v_plan.id and module_id = v_id) then
      raise exception 'o módulo "%" já está incluído no plano', v_mod.name;
    end if;
  end loop;

  -- Período grátis: se o prazo já venceu e o agendador ainda não rodou, a
  -- expiração é registrada agora; depois disso o teste está 'trialing' (dentro
  -- do prazo), 'expired', 'canceled' ou não existe.
  perform public.reconcile_company_trial(p_company_id);
  select * into v_trial from public.company_trials where company_id = p_company_id for update;
  if v_trial.id is not null and v_trial.status in ('trialing', 'expired') then
    v_from_trial := jsonb_build_object(
      'trial_id', v_trial.id,
      'trial_started_at', v_trial.trial_started_at,
      'trial_ends_at', v_trial.trial_ends_at,
      'converted_during_trial', v_trial.status = 'trialing');
  end if;

  insert into public.subscriptions (
    company_id, plan_id, plan_price_cents_snapshot, status, billing_day, started_at,
    current_period_start, current_period_end
  ) values (
    p_company_id, v_plan.id, v_plan.monthly_price_cents, 'pending_payment',
    v_day, v_now, v_start, (v_start + interval '1 month - 1 day')::date
  ) returning * into v_sub;

  -- Snapshot da composição incluída no plano
  insert into public.subscription_modules (subscription_id, module_id, source, plan_id, price_cents_snapshot)
  select v_sub.id, pm.module_id, 'plan', v_plan.id, 0
  from public.plan_modules pm where pm.plan_id = v_plan.id;

  foreach v_id in array v_ids loop
    select * into v_mod from public.modules where id = v_id;
    insert into public.subscription_modules (subscription_id, module_id, source, price_cents_snapshot)
    values (v_sub.id, v_id, 'extra', v_mod.monthly_price_cents);
    perform public.record_subscription_event(v_sub.id, 'module_added', jsonb_build_object(
      'module_id', v_id, 'module_code', v_mod.code, 'price_cents', v_mod.monthly_price_cents));
  end loop;

  perform public.record_subscription_event(v_sub.id, 'subscribed', jsonb_build_object(
    'plan_id', v_plan.id, 'plan_code', v_plan.code,
    'plan_price_cents', v_plan.monthly_price_cents,
    'billing_day', v_day, 'status', v_sub.status,
    'included_modules', coalesce((
      select jsonb_agg(jsonb_build_object('module_id', m.id, 'code', m.code) order by m.code)
      from public.subscription_modules sm join public.modules m on m.id = sm.module_id
      where sm.subscription_id = v_sub.id and sm.source = 'plan'
    ), '[]'::jsonb)
  ) || case when v_from_trial is null then '{}'::jsonb
            else jsonb_build_object('from_trial', v_from_trial) end);

  -- Cobrança inicial imediata (integral, sem prorrata), vencendo hoje.
  v_initial := public.generate_initial_invoice(v_sub.id);

  -- Conversão do período grátis: encerra o teste e liga à nova assinatura.
  if v_from_trial is not null then
    update public.company_trials
    set status = 'converted',
        converted_at = v_now,
        converted_subscription_id = v_sub.id,
        converted_by = auth.uid(),
        converted_via = 'master_subscribe_company'
    where id = v_trial.id;

    perform public.record_company_trial_event(v_trial.id, 'converted', jsonb_build_object(
      'flow', 'master_subscribe_company',
      'converted_during_trial', v_trial.status = 'trialing',
      'trial_started_at', v_trial.trial_started_at,
      'trial_ends_at', v_trial.trial_ends_at,
      'converted_at', v_now,
      'subscription_id', v_sub.id,
      'plan_id', v_plan.id, 'plan_code', v_plan.code,
      'plan_price_cents', v_plan.monthly_price_cents,
      'billing_day', v_day,
      'initial_invoice_id', v_initial ->> 'invoice_id',
      'actor_id', auth.uid()));
  end if;

  select * into v_sub from public.subscriptions where id = v_sub.id;
  return v_sub;
end;
$$;

-- Início do período grátis (regra 5e). Explícito: NÃO é inferido de plano nem de
-- preço R$ 0, e NÃO depende do catálogo (funciona com o plano 'trial' inexistente,
-- inativo, renomeado ou com outro preço). A duração é sempre a regra de backend
-- (trial_duration_days). Não cria assinatura, fatura, cobrança, dívida nem âncora.
create function public.master_start_trial(p_company_id uuid)
returns public.company_trials
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := public.business_now();
  v_days integer := public.trial_duration_days();
  v_trial public.company_trials;
begin
  perform public.assert_master_admin();

  -- Serializa com contratação/cancelamento da mesma empresa.
  perform 1 from public.companies where id = p_company_id for no key update;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  -- Um por empresa, para sempre: qualquer registro (mesmo cancelado, expirado ou
  -- convertido) barra. O UNIQUE(company_id) é a barreira final.
  if exists (select 1 from public.company_trials where company_id = p_company_id) then
    raise exception 'esta empresa já utilizou o período grátis (um por empresa)';
  end if;
  if exists (select 1 from public.subscriptions where company_id = p_company_id and status <> 'canceled') then
    raise exception 'a empresa já possui uma assinatura vigente: o período grátis é só para quem ainda não contratou';
  end if;

  insert into public.company_trials (company_id, trial_started_at, trial_days, started_by)
  values (p_company_id, v_now, v_days, auth.uid())
  returning * into v_trial;

  perform public.record_company_trial_event(v_trial.id, 'started', jsonb_build_object(
    'flow', 'master_start_trial',
    'trial_started_at', v_trial.trial_started_at,
    'trial_ends_at', v_trial.trial_ends_at,
    'trial_days', v_trial.trial_days,
    'business_date', (v_now at time zone 'America/Sao_Paulo')::date,
    'actor_id', auth.uid()));

  return v_trial;
end;
$$;

-- Cancelamento antecipado (Master). Só enquanto o teste está em andamento; NÃO
-- libera novo teste (o registro fica para sempre).
create function public.master_cancel_trial(p_company_id uuid, p_reason text default null)
returns public.company_trials
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := public.business_now();
  v_trial public.company_trials;
begin
  perform public.assert_master_admin();

  perform 1 from public.companies where id = p_company_id for no key update;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  -- se o prazo já venceu, o teste expirou (não pode ser cancelado)
  perform public.reconcile_company_trial(p_company_id);

  select * into v_trial from public.company_trials where company_id = p_company_id for update;
  if not found then
    raise exception 'a empresa não tem período grátis';
  end if;
  if v_trial.status <> 'trialing' then
    raise exception 'o período grátis já foi encerrado (%)', v_trial.status;
  end if;

  update public.company_trials
  set status = 'canceled',
      canceled_at = v_now,
      canceled_by = auth.uid(),
      cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = v_trial.id
  returning * into v_trial;

  perform public.record_company_trial_event(v_trial.id, 'canceled', jsonb_build_object(
    'reason', v_trial.cancel_reason,
    'trial_started_at', v_trial.trial_started_at,
    'trial_ends_at', v_trial.trial_ends_at,
    'canceled_at', v_now,
    'actor_id', auth.uid()));

  return v_trial;
end;
$$;

-- Ajuste EXCEPCIONAL e explícito do dia de vencimento (regra 5c), só DEPOIS da
-- contratação estar paga: enquanto a cobrança inicial não for paga (pending_payment)
-- a âncora fica congelada (regra 5f; o banco repete a trava por trigger). O
-- billing_day nasce da contratação paga; esta é a única forma de mudá-lo, sempre
-- por ação do Master e sempre auditada. Vale pela regra de vigência da fase 3
-- (primeira competência AINDA NÃO FATURADA — o trigger subscription_terms grava a
-- versão): nunca altera fatura já gerada e não recalcula a cobrança inicial.
create or replace function public.master_set_billing_day(p_subscription_id uuid, p_billing_day integer)
returns public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.subscriptions;
  v_old smallint;
  v_effective date;
  v_last_invoiced date;
begin
  perform public.assert_master_admin();

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'assinatura não encontrada'; end if;
  if v_sub.status = 'canceled' then raise exception 'assinatura cancelada não pode ser alterada'; end if;
  if p_billing_day is null or p_billing_day not between 1 and 31 then
    raise exception 'billing_day deve estar entre 1 e 31';
  end if;
  if p_billing_day = v_sub.billing_day then return v_sub; end if;
  if not public.subscription_initial_charge_settled(v_sub.id) then
    raise exception 'a cobrança inicial desta assinatura não está paga: o dia de vencimento só pode ser ajustado depois do pagamento (ou cancele e contrate de novo)';
  end if;

  v_old := v_sub.billing_day;
  update public.subscriptions set billing_day = p_billing_day where id = v_sub.id
  returning * into v_sub;

  -- competência de vigência = a versão contratual que o trigger acabou de gravar
  select t.effective_from_competence into v_effective
  from public.subscription_terms t
  where t.subscription_id = v_sub.id
  order by t.seq desc limit 1;
  select max(i.competence) into v_last_invoiced
  from public.invoices i where i.subscription_id = v_sub.id;

  perform public.record_subscription_event(v_sub.id, 'billing_day_changed', jsonb_build_object(
    'from', v_old, 'to', p_billing_day,
    'effective_from_competence', v_effective,
    'last_invoiced_competence', v_last_invoiced,
    'source', 'manual',
    'actor_id', auth.uid()));

  return v_sub;
end;
$$;

-- Lista de empresas com a situação da assinatura E do período grátis. O tipo de
-- retorno muda, então DROP + CREATE.
drop function public.master_list_companies();

create function public.master_list_companies()
returns table (
  id uuid,
  name text,
  document text,
  created_at timestamptz,
  member_count bigint,
  subscription_id uuid,
  subscription_status text,
  plan_id uuid,
  plan_name text,
  trial_state text,
  trial_ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_master_admin();

  return query
  select
    c.id, c.name, c.document, c.created_at,
    (select count(*) from public.company_users cu where cu.company_id = c.id)::bigint,
    s.id, s.status, p.id, p.name,
    case when ct.id is null then null
         else public.trial_effective_state(ct.status, ct.trial_ends_at) end,
    ct.trial_ends_at
  from public.companies c
  left join public.subscriptions s on s.company_id = c.id and s.status <> 'canceled'
  left join public.plans p on p.id = s.plan_id
  left join public.company_trials ct on ct.company_id = c.id
  order by c.created_at desc;
end;
$$;

-- Visão completa de UMA empresa para o Master. Igual à da fase 2, acrescida do
-- bloco `trial` (derivado em tempo real).
create or replace function public.master_get_company(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company public.companies;
  v_sub public.subscriptions;
  v_result jsonb;
  v_subscription jsonb := null;
begin
  perform public.assert_master_admin();

  select * into v_company from public.companies where id = p_company_id;
  if not found then
    raise exception 'empresa não encontrada';
  end if;

  select * into v_sub from public.subscriptions
  where company_id = p_company_id and status <> 'canceled';

  if found then
    v_subscription := jsonb_build_object(
      'id', v_sub.id,
      'status', v_sub.status,
      'billing_day', v_sub.billing_day,
      'started_at', v_sub.started_at,
      'current_period_start', v_sub.current_period_start,
      'current_period_end', v_sub.current_period_end,
      'grace_until', v_sub.grace_until,
      -- false = contrato cobrado CONGELADO (plano, módulos e dia não mudam até pagar)
      'initial_charge_settled', public.subscription_initial_charge_settled(v_sub.id),
      'plan', (
        select jsonb_build_object(
          'id', pl.id, 'code', pl.code, 'name', pl.name,
          'price_cents_snapshot', v_sub.plan_price_cents_snapshot,
          'catalog_price_cents', pl.monthly_price_cents,
          'is_active', pl.is_active,
          'limits', coalesce((select jsonb_object_agg(l.limit_key, l.limit_value)
                              from public.plan_limits l where l.plan_id = pl.id), '{}'::jsonb)
        ) from public.plans pl where pl.id = v_sub.plan_id
      ),
      -- Composição CONTRATADA (snapshot), nunca o plan_modules vivo do catálogo.
      'included_modules', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'name', m.name) order by m.name)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id and sm.source = 'plan' and sm.removed_at is null
      ), '[]'::jsonb),
      'extra_modules', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sm.id, 'module_id', m.id, 'code', m.code, 'name', m.name,
          'price_cents_snapshot', sm.price_cents_snapshot, 'added_at', sm.added_at
        ) order by sm.added_at)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id and sm.source = 'extra' and sm.removed_at is null
      ), '[]'::jsonb),
      'module_history', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', sm.id, 'code', m.code, 'name', m.name, 'source', sm.source,
          'plan_id', sm.plan_id, 'price_cents_snapshot', sm.price_cents_snapshot,
          'added_at', sm.added_at, 'removed_at', sm.removed_at
        ) order by sm.added_at, m.name)
        from public.subscription_modules sm join public.modules m on m.id = sm.module_id
        where sm.subscription_id = v_sub.id
      ), '[]'::jsonb),
      'events', coalesce((
        select jsonb_agg(e order by e.created_at desc) from (
          select ev.id, ev.event_type, ev.payload, ev.created_at, pr.email as actor_email
          from public.subscription_events ev
          left join public.profiles pr on pr.user_id = ev.actor_id
          where ev.subscription_id = v_sub.id
          order by ev.created_at desc limit 100
        ) e
      ), '[]'::jsonb)
    );
  end if;

  v_result := jsonb_build_object(
    'company', jsonb_build_object(
      'id', v_company.id, 'name', v_company.name, 'slug', v_company.slug,
      'document', v_company.document, 'created_at', v_company.created_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', cu.user_id, 'email', pr.email, 'full_name', pr.full_name, 'role', cu.role
      ) order by cu.created_at)
      from public.company_users cu left join public.profiles pr on pr.user_id = cu.user_id
      where cu.company_id = p_company_id
    ), '[]'::jsonb),
    'subscription', v_subscription,
    'trial', public.company_trial_json(p_company_id),
    'past_subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'plan_name', pl.name, 'price_cents_snapshot', s.plan_price_cents_snapshot,
        'started_at', s.started_at, 'canceled_at', s.canceled_at
      ) order by s.started_at desc)
      from public.subscriptions s join public.plans pl on pl.id = s.plan_id
      where s.company_id = p_company_id and s.status = 'canceled'
    ), '[]'::jsonb)
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACL explícita
-- ---------------------------------------------------------------------------
revoke execute on function public.generate_initial_invoice(uuid) from public, anon, authenticated;
revoke execute on function public.master_subscribe_company(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.master_subscribe_company(uuid, uuid, uuid[]) to authenticated;
revoke execute on function public.business_date() from public, anon, authenticated;
revoke execute on function public.billing_grace_days() from public, anon, authenticated;
revoke execute on function public.billing_invoice_lead_days() from public, anon, authenticated;
revoke execute on function public.billing_debt_of(uuid) from public, anon, authenticated;
revoke execute on function public.billing_status_rank(text) from public, anon, authenticated;
revoke execute on function public.reconcile_subscription_billing_state(uuid) from public, anon, authenticated;
revoke execute on function public.auto_generate_subscription_invoices(uuid) from public, anon, authenticated;
revoke execute on function public.run_billing_cycle() from public, anon, authenticated;

revoke execute on function public.master_list_invoices(uuid, text, date) from public, anon;
revoke execute on function public.master_get_billing_state(uuid) from public, anon;
revoke execute on function public.master_run_billing_cycle() from public, anon;
grant execute on function public.master_list_invoices(uuid, text, date) to authenticated;
grant execute on function public.master_get_billing_state(uuid) to authenticated;
grant execute on function public.master_run_billing_cycle() to authenticated;

-- Ativação e período grátis: helpers, triggers e reconciliadores são INTERNOS
-- (nenhum role de cliente executa); só as RPCs Master abaixo são expostas.
revoke execute on function public.subscription_initial_charge_settled(uuid) from public, anon, authenticated;
revoke execute on function public.subscription_initial_charge_paid(uuid) from public, anon, authenticated;
revoke execute on function public.guard_subscription_activation() from public, anon, authenticated;
revoke execute on function public.check_pending_subscription_has_initial() from public, anon, authenticated;
revoke execute on function public.guard_subscription_commercial_change() from public, anon, authenticated;
revoke execute on function public.guard_subscription_modules_frozen() from public, anon, authenticated;
revoke execute on function public.guard_recurring_invoice_needs_initial() from public, anon, authenticated;
revoke execute on function public.initial_invoice_to_void_on_cancel(uuid, text) from public, anon, authenticated;
revoke execute on function public.void_unpaid_initial_on_cancel() from public, anon, authenticated;
revoke execute on function public.trial_reserved_plan_code() from public, anon, authenticated;
revoke execute on function public.trial_duration_days() from public, anon, authenticated;
revoke execute on function public.trial_end_of(timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.trial_effective_state(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.set_company_trial_window() from public, anon, authenticated;
revoke execute on function public.guard_company_trial_change() from public, anon, authenticated;
revoke execute on function public.prevent_company_trial_event_change() from public, anon, authenticated;
revoke execute on function public.check_trial_subscription_exclusive() from public, anon, authenticated;
revoke execute on function public.guard_subscription_plan_not_trial() from public, anon, authenticated;
revoke execute on function public.record_company_trial_event(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.company_trial_state(uuid) from public, anon, authenticated;
revoke execute on function public.company_has_active_trial(uuid) from public, anon, authenticated;
revoke execute on function public.reconcile_company_trial(uuid) from public, anon, authenticated;
revoke execute on function public.reconcile_expired_trials() from public, anon, authenticated;
revoke execute on function public.company_trial_json(uuid) from public, anon, authenticated;

revoke execute on function public.master_start_trial(uuid) from public, anon;
revoke execute on function public.master_cancel_trial(uuid, text) from public, anon;
revoke execute on function public.master_set_billing_day(uuid, integer) from public, anon;
revoke execute on function public.master_list_companies() from public, anon;
revoke execute on function public.master_get_company(uuid) from public, anon;
grant execute on function public.master_start_trial(uuid) to authenticated;
grant execute on function public.master_cancel_trial(uuid, text) to authenticated;
grant execute on function public.master_set_billing_day(uuid, integer) to authenticated;
grant execute on function public.master_list_companies() to authenticated;
grant execute on function public.master_get_company(uuid) to authenticated;

-- RPCs já existentes cujo corpo foi substituído nesta migration (CREATE OR REPLACE
-- preserva a ACL): reafirmada aqui para a migration ser autoexplicativa.
revoke execute on function public.master_get_invoice(uuid) from public, anon;
revoke execute on function public.master_mark_invoice_paid(uuid, timestamptz) from public, anon;
revoke execute on function public.master_void_invoice(uuid, text) from public, anon;
revoke execute on function public.master_set_subscription_status(uuid, text, date) from public, anon;
grant execute on function public.master_get_invoice(uuid) to authenticated;
grant execute on function public.master_mark_invoice_paid(uuid, timestamptz) to authenticated;
grant execute on function public.master_void_invoice(uuid, text) to authenticated;
grant execute on function public.master_set_subscription_status(uuid, text, date) to authenticated;
