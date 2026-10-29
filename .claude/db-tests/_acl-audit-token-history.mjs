// Auditoria de ACL da 20261107010000: compara funções/tabelas ANTES (migrations < 1107) e DEPOIS, e confere o que a migration criou/alterou.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAll } from "./full-db.mjs";

const SRC = "D:/orça facil/supabase/migrations";
const NEW = "20261110010000_whatsapp_token_sweep_history.sql";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acl-hist-pre-"));
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f < NEW) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
const q = `select p.oid::regprocedure::text sig, p.prosecdef secdef, coalesce(array_to_string(p.proconfig, ','), '') cfg, md5(p.prosrc) h,
  (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type='EXECUTE')::int pub,
  has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') svc
  from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`;
const tq = `select c.relname, c.relrowsecurity rls, has_table_privilege('anon', c.oid, 'select') a, has_table_privilege('authenticated', c.oid, 'select') u, has_table_privilege('authenticated', c.oid, 'insert') ui, has_table_privilege('service_role', c.oid, 'select') s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`;
const pre = await loadAll(tmp, { legacyIaMirror: false });
const before = new Map((await pre.pg.query(q)).rows.map((r) => [r.sig, r]));
const beforeT = new Map((await pre.pg.query(tq)).rows.map((r) => [r.relname, r]));
const tmpPost = fs.mkdtempSync(path.join(os.tmpdir(), "acl-post-"));
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".sql") && f <= NEW) fs.copyFileSync(path.join(SRC, f), path.join(tmpPost, f)); // só até a migration auditada (as posteriores têm auditoria própria)
const post = await loadAll(tmpPost, { legacyIaMirror: false });
const after = (await post.pg.query(q)).rows;
const afterT = (await post.pg.query(tq)).rows;
let bad = 0;
const flag = (m) => { bad++; console.log("PROBLEMA:", m); };
const exp = {
  "master_whatsapp_token_sweep_history(text,text,integer,integer)": { anon: false, auth: true, svc: false },
};
for (const r of after) {
  const short = r.sig.replace("public.", "").replace(/, /g, ",");
  const prev = before.get(r.sig);
  if (!prev) {
    console.log(`NOVA   ${short}  secdef=${r.secdef} cfg=${r.cfg} public=${r.pub} anon=${r.anon} auth=${r.auth} svc=${r.svc}`);
    if (!r.secdef) flag(short + " não é SECURITY DEFINER");
    if (!/search_path=public/.test(r.cfg)) flag(short + " sem search_path fixo");
    if (r.pub !== 0 || r.anon) flag(short + " executável por PUBLIC/anon");
    const e = exp[short];
    if (!e) flag(short + " função nova não esperada");
    else if (e.auth !== r.auth || e.svc !== r.svc) flag(`${short} ACL diferente do esperado (auth=${r.auth}, svc=${r.svc})`);
  } else if (prev.h !== r.h) {
    console.log(`ALTERADA ${short}  public=${r.pub} anon=${r.anon} auth=${r.auth} svc=${r.svc} (antes: public=${prev.pub} anon=${prev.anon} auth=${prev.auth} svc=${prev.svc})`);
    if (prev.pub !== r.pub || prev.anon !== r.anon || prev.auth !== r.auth || prev.svc !== r.svc) flag(short + " ACL mudou");
    if (!r.secdef || !/search_path=public/.test(r.cfg)) flag(short + " alterada sem SECURITY DEFINER/search_path fixo");
  } else if (prev.pub !== r.pub || prev.anon !== r.anon || prev.auth !== r.auth || prev.svc !== r.svc) flag(short + " ACL mudou sem mudar o corpo");
}
for (const t of afterT) {
  const prev = beforeT.get(t.relname);
  if (!prev) {
    console.log(`TABELA NOVA ${t.relname} rls=${t.rls} anon_select=${t.a} auth_select=${t.u} auth_insert=${t.ui} svc_select=${t.s}`);
    if (!t.rls || t.a || t.u || t.ui || !t.s) flag("tabela " + t.relname + " com ACL/RLS inesperada");
  } else if (JSON.stringify(prev) !== JSON.stringify(t)) flag("tabela " + t.relname + " mudou de ACL");
}
console.log(bad ? `\nAUDITORIA ACL: ${bad} problema(s)` : "\nAUDITORIA ACL: OK (só a RPC de histórico, sem tabela nova; nenhuma ACL existente mudou)");
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
