-- Rebranding textual: "OrçaFácil" -> "Gestão de Atendimento Pro" nas descrições
-- do catálogo comercial (planos e módulos). Não altera ids, códigos, preços,
-- status nem regras comerciais.
update public.plans
   set description = replace(description, 'OrçaFácil', 'Gestão de Atendimento Pro')
 where description like '%OrçaFácil%';

update public.modules
   set description = replace(description, 'OrçaFácil', 'Gestão de Atendimento Pro')
 where description like '%OrçaFácil%';
