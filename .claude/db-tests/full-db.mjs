import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

// Carregador compartilhado (2026-09-26): banco descartável com TODAS as migrations reais, exceto o
// agendamento pg_cron (só existe no Supabase), mais shims mínimos de `auth` e `storage`. Serve às
// suítes novas que precisam das migrations POSTERIORES à 095000 (as antigas ainda filtram por `<`).
// Uso:  const { pg, ck, as, su, errHas, summary } = await loadAll();
export async function loadAll(dir = process.env.MIG_DIR ?? "D:/orça facil/supabase/migrations", { skipActivation = false, legacyIaMirror = true } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    create function auth.email() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.email', true),'') $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    -- PIOR CASO de ACL: função nova nasce executável por todos; só os revoke da migration fecham.
    alter default privileges in schema public grant execute on functions to public, anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null unique, owner uuid,
      created_at timestamptz default now(), updated_at timestamptz default now(),
      public boolean default false, avif_autodetection boolean default false,
      file_size_limit bigint, allowed_mime_types text[], owner_id text
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets(id),
      name text, owner uuid, owner_id text,
      created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(),
      metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored,
      version text, user_metadata jsonb
    );
    create unique index bucketid_objname on storage.objects (bucket_id, name);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language plpgsql as $f$
    declare _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts, 1) - 1];
    end $f$;
    grant usage on schema storage to anon, authenticated, service_role;
    grant all on all tables in schema storage to anon, authenticated, service_role;
    grant execute on function storage.foldername(text) to anon, authenticated, service_role;
  `);
  await pg.exec(`do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;`);
  await pg.exec(`create schema if not exists net; create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb); create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $f$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $f$; create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);`);
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && !/billing_cron|push_cron/.test(x) && !(skipActivation && /activate_delivery_module/.test(x))).sort()) {
    await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }

  // As suítes ANTERIORES à separação WhatsApp/IA concedem só 'whatsapp'; este espelho (só no banco de teste) concede 'ia' junto,
  // como a migration 20261028010000 faz em produção. A suíte whatsapp-ia-modules.mjs roda com legacyIaMirror:false.
  if (legacyIaMirror && (await pg.query("select to_regclass('public.company_module_overrides') t")).rows[0].t) await pg.exec(`create function public.__test_mirror_ia() returns trigger language plpgsql as $f$ begin
      if new.module_code = 'whatsapp' and exists (select 1 from public.modules where code = 'ia') then insert into public.company_module_overrides (company_id, module_code, reason, expires_at) values (new.company_id, 'ia', 'espelho de teste', new.expires_at) on conflict do nothing; end if; return new; end $f$;
    create trigger __test_mirror_ia after insert on public.company_module_overrides for each row execute function public.__test_mirror_ia();`);

  let pass = 0, fail = 0;
  const ck = (l, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS" : "FAIL") + " - " + l + (c ? "" : " :: " + String(x).slice(0, 500))); };
  const fmt = (e) => ({ ok: false, err: e.message, code: e.code });
  async function as(role, uid, sql, params) {
    await pg.exec(`select set_config('request.jwt.claim.sub','${uid ?? ""}',false); set role ${role};`);
    try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; }
    catch (e) { return fmt(e); }
    finally { await pg.exec("reset role;"); }
  }
  const su = async (sql, params) => { try { const r = await pg.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows }; } catch (e) { return fmt(e); } };
  const errHas = (r, re, code) => !r.ok && re.test(r.err) && (code === undefined || r.code === code);
  const summary = (title) => { console.log(`\nRESULTADO ${title}: ${pass} ok / ${fail} falhas`); process.exit(fail ? 1 : 0); };
  return { pg, ck, as, su, errHas, summary };
}
