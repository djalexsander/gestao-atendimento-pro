update public.plans
set description = replace(
  description,
  'Gestão de Atendimento Pro',
  'Gestão Atendimento Pro'
)
where description like '%Gestão de Atendimento Pro%';

update public.modules
set description = replace(
  description,
  'Gestão de Atendimento Pro',
  'Gestão Atendimento Pro'
)
where description like '%Gestão de Atendimento Pro%';