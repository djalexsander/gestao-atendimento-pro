-- Funcionários e acesso — etapa 1: papéis da empresa.
--
-- company_role passa de   owner | admin | agent
--                    para owner | admin | attendant | cashier
--   * 'agent' é RENOMEADO para 'attendant' (ALTER TYPE ... RENAME VALUE). É o
--     mesmo valor interno do enum: linhas existentes de company_users e
--     company_invites, policies e demais expressões já compiladas que o
--     referenciam passam a enxergar 'attendant' sem reescrever nenhum dado.
--   * 'cashier' é acrescentado ao FINAL do enum.
--
-- ADD VALUE: o valor novo só pode ser USADO depois do commit da transação que
-- o criou (regra do PostgreSQL). Esta migration não o usa; as policies e
-- funções que passarem a tratar 'cashier' vêm em migrations seguintes, de
-- propósito.
--
-- role deixa de ter DEFAULT em company_users e company_invites: a função do
-- membro/convite passa a ser sempre informada explicitamente. Nenhum INSERT
-- existente depende do default (create_company grava 'owner';
-- create_company_invite e accept_company_invite gravam a role explicitamente).
--
-- Não altera nenhuma linha: o vínculo owner existente continua owner. Também
-- não reescreve policies nem funções — o texto delas nas migrations
-- anteriores continua dizendo 'agent', mas o objeto no banco já é 'attendant'.
alter type public.company_role rename value 'agent' to 'attendant';
alter type public.company_role add value 'cashier';

alter table public.company_users alter column role drop default;
alter table public.company_invites alter column role drop default;
