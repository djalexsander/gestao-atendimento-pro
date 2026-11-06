// Biblioteca comum das ferramentas de cortesias (pré-flight de deriva e validação de rollback). SOMENTE banco descartável (PGlite).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MIG = path.join(ROOT, "supabase/migrations");
export const COURTESY = [
  "20261115010000_company_courtesies.sql",
  "20261116010000_courtesy_entitlement.sql",
  "20261117010000_courtesy_billing.sql",
  "20261118010000_courtesy_conversion.sql",
  "20261119010000_courtesy_bridge.sql",
  "20261120010000_courtesy_expiry_cycle.sql",
  "20261121010000_courtesy_preserved_access.sql",
  "20261122010000_courtesy_alerts_tenant_access.sql",
];
export const ROLLBACK_DIR = path.join(ROOT, "supabase/rollbacks/courtesies");
export const rollbackFile = (migration) => path.join(ROLLBACK_DIR, migration.replace(/\.sql$/, ".rollback.sql"));
export const PREFLIGHT_DIR = path.join(ROOT, "supabase/preflight/courtesies");

export const loadAllFn = async () => (await import(pathToFileURL(path.join(ROOT, ".claude/db-tests/full-db.mjs")).href)).loadAll;

// Diretório temporário com as migrations anteriores às cortesias + as k primeiras cortesias (k = 0..6). Nunca altera o repositório.
export function stageDir(k) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `courtesy-stage${k}-`));
  for (const f of fs.readdirSync(MIG)) {
    if (!f.endsWith(".sql")) continue;
    if (f < "20261115010000") fs.copyFileSync(path.join(MIG, f), path.join(d, f));
  }
  for (const f of COURTESY.slice(0, k)) fs.copyFileSync(path.join(MIG, f), path.join(d, f));
  return d;
}

// Expressão do "hash da função": corpo normalizado (sem CR, espaços colapsados — sem barra invertida, pois a CLI do Supabase a consome),
// mais segurança (SECURITY DEFINER), search_path/config, volatilidade e tipo de retorno. Idêntica no gerador e na sonda remota.
export const FN_KEY = `p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'`;
export const FN_HASH = `md5(regexp_replace(replace(p.prosrc, chr(13), ''), '[[:space:]]+', ' ', 'g') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || p.provolatile::text || '|' || pg_get_function_result(p.oid))`;
export const TABLE_SIG = `select c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text k
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
 where n.nspname = 'public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped`;

export async function fnHashes(pg) {
  const r = await pg.query(`select ${FN_KEY} k, ${FN_HASH} h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' order by 1`);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.h]));
}
export async function tableCols(pg) {
  const r = await pg.query(`select k from (${TABLE_SIG}) t order by 1`);
  return r.rows.map((x) => x.k);
}
// Assinatura completa do schema (para comparar rollback x estado anterior): funções (hash + ACL), colunas, políticas, triggers, índices, constraints.
export async function schemaSig(pg) {
  const q = async (sql) => (await pg.query(sql)).rows.map((r) => r.k);
  return {
    fns: await q(`select ${FN_KEY} || '|' || ${FN_HASH} || '|' || has_function_privilege('anon', p.oid, 'execute')::text || has_function_privilege('authenticated', p.oid, 'execute')::text || has_function_privilege('service_role', p.oid, 'execute')::text k
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' order by 1`),
    cols: await q(`select k from (${TABLE_SIG}) t order by 1`),
    tables: await q(`select c.relname || ':' || c.relrowsecurity::text k from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v') order by 1`),
    pol: await q(`select tablename || '.' || policyname || '.' || cmd || '.' || coalesce(qual, '') || '.' || coalesce(with_check, '') k from pg_policies where schemaname = 'public' order by 1`),
    trg: await q(`select event_object_table || '.' || trigger_name k from information_schema.triggers where trigger_schema = 'public' order by 1`),
    idx: await q(`select tablename || '.' || indexname || '.' || indexdef k from pg_indexes where schemaname = 'public' order by 1`),
    con: await q(`select conrelid::regclass::text || '.' || conname || '.' || pg_get_constraintdef(oid) k from pg_constraint where connamespace = 'public'::regnamespace order by 1`),
  };
}
export const sigDiff = (a, b) => Object.keys(a).flatMap((k) => [...a[k].filter((x) => !b[k].includes(x)).map((x) => `+${k}:${x}`), ...b[k].filter((x) => !a[k].includes(x)).map((x) => `-${k}:${x}`)]);
export const N = COURTESY.length;
