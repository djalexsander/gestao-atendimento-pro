-- Reverte 20261212010000_whatsapp_ai_catalog_menu.sql: remove SOMENTE a função de leitura nova.
-- A função não tem dependentes no banco (nenhuma outra função/view a referencia) e não grava dados: não há dado a restaurar.
-- Ordem de publicação: rodar este rollback ANTES de reverter a Edge whatsapp-ai-auto NÃO é necessário — a Edge trata a ausência da função
-- (erro na RPC => segue o fluxo normal) — mas o ideal é reverter a Edge primeiro.
do $rb$
declare
  v_oid oid := to_regprocedure('public.whatsapp_ai_catalog_menu_job(uuid, text)');
  v_dep integer;
begin
  if v_oid is null then
    raise exception 'rollback: whatsapp_ai_catalog_menu_job(uuid, text) não existe (já revertida?)';
  end if;
  -- segurança: só remove se a assinatura for exatamente a da migration (2 argumentos: uuid, text) e o retorno for jsonb
  if (select pronargs from pg_proc where oid = v_oid) <> 2 or (select prorettype from pg_proc where oid = v_oid) <> 'jsonb'::regtype then
    raise exception 'rollback: assinatura inesperada; nada foi removido';
  end if;
  -- segurança: nenhuma outra função pública pode referenciá-la
  select count(*) into v_dep from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.oid <> v_oid and p.prosrc like '%whatsapp_ai_catalog_menu_job%';
  if v_dep > 0 then
    raise exception 'rollback: % função(ões) ainda referenciam whatsapp_ai_catalog_menu_job; nada foi removido', v_dep;
  end if;
  drop function public.whatsapp_ai_catalog_menu_job(uuid, text);
end
$rb$;
