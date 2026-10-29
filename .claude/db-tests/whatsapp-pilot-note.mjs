// NOTA OBRIGATÓRIA NO PILOTO (Etapa 10.1): master_whatsapp_pilot_set valida o motivo no banco. PGlite + todas as migrations.
import { loadAll } from "./full-db.mjs";

const { pg, ck, as, su: su0, summary } = await loadAll();
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const master = id(5001), owner = id(5002);
await su(`insert into auth.users (id,email) values ('${master}','m@x.com'), ('${owner}','o@x.com')`);
await su(`insert into public.profiles (user_id,email,full_name) values ('${master}','m@x.com','m'), ('${owner}','o@x.com','o') on conflict (user_id) do nothing`);
await su("insert into platform_admins (user_id) values ($1)", [master]);
const mk = async (n) => (await su("insert into companies (name,slug,document,email) values ($1,$2,$3,'n@x.com') returning id", [`Emp ${n}`, `note-${n}`, `1122233300${String(n).padStart(4, "0")}`])).rows[0].id;
const A = await mk(1), B = await mk(2), C = await mk(3);
await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [A, owner]);
const M = (sql, p) => as("authenticated", master, sql, p);
const set = (c, on, note) => M("select public.master_whatsapp_pilot_set($1,$2,$3) j", [c, on, note]);
const rows = async (c) => (await su("select * from whatsapp_signup_pilot_companies where company_id=$1", [c])).rows;
const evs = async (c) => (await su("select * from whatsapp_signup_pilot_events where company_id=$1 order by created_at, id", [c])).rows;
const total = async () => (await su("select (select count(*) from whatsapp_signup_pilot_companies) a, (select count(*) from whatsapp_signup_pilot_events) b")).rows[0];

console.log("\n== 1. autorizar exige motivo ==");
for (const [label, v] of [["nulo", null], ["vazio", ""], ["só espaços", "     "], ["só tabs/quebras", "\t\n \t"], ["curto (4)", "abcd"], ["curto com espaços (4 úteis)", "   abcd   "]]) {
  const r = await set(A, true, v);
  ck(`1.${label}: autorizar recusado (PT400) e nada gravado`, !r.ok && r.code === "PT400" && (await rows(A)).length === 0 && (await evs(A)).length === 0);
}
{
  const r = await M("select public.master_whatsapp_pilot_set($1, true) j", [A]);
  ck("1.omitido: chamada sem o parâmetro de nota também é recusada", !r.ok && r.code === "PT400" && (await rows(A)).length === 0);
}
ck("1.limite: 501 caracteres recusado (não trunca em silêncio); 500 aceito e gravado inteiro",
  (await set(A, true, "x".repeat(501))).code === "PT400" && (await rows(A)).length === 0 && (await set(A, true, "y".repeat(500))).ok && (await rows(A))[0].note.length === 500);
ck("1.limite: 501 contando só os úteis (com espaços nas pontas) também é recusado", (await set(B, true, "  " + "z".repeat(501) + "  ")).code === "PT400" && (await rows(B)).length === 0);

console.log("\n== 2. revogar exige motivo ==");
{
  const before = await total();
  for (const v of [null, "", "      ", "abc"]) {
    const r = await set(A, false, v);
    ck(`2.revogar com motivo ${JSON.stringify(v)} recusado e a autorização permanece`, !r.ok && r.code === "PT400" && (await rows(A))[0].authorized === true);
  }
  const after = await total();
  ck("2.5 nenhuma linha/evento a mais após as recusas", before.a === after.a && before.b === after.b);
}

console.log("\n== 3. caminho feliz e auditoria ==");
{
  const ok = await set(B, true, "  piloto da empresa B  ");
  const row = (await rows(B))[0], ev = await evs(B);
  ck("3.1 autoriza com motivo aparado; grava autor, data e nota", ok.ok && ok.rows[0].j.changed === true && row.authorized === true && row.authorized_by === master && !!row.authorized_at && row.note === "piloto da empresa B");
  ck("3.2 evento 'authorized' guarda o motivo aparado e o ator", ev.length === 1 && ev[0].action === "authorized" && ev[0].note === "piloto da empresa B" && ev[0].actor_user_id === master);
  const rev = await set(B, false, "encerrado a pedido da empresa");
  const ev2 = await evs(B);
  ck("3.3 revoga com motivo: evento 'revoked' com a nota, ator e linha atualizada", rev.ok && rev.rows[0].j.changed === true && (await rows(B))[0].authorized === false && (await rows(B))[0].revoked_by === master && ev2.length === 2 && ev2[1].action === "revoked" && ev2[1].note === "encerrado a pedido da empresa");
  const again = await set(B, true, "reautorizada após revisão");
  ck("3.4 reautorizar substitui a nota atual pela nova e limpa a revogação", again.ok && (await rows(B))[0].note === "reautorizada após revisão" && (await rows(B))[0].revoked_at === null && (await rows(B))[0].authorized_by === master && !!(await rows(B))[0].authorized_at && (await evs(B)).length === 3);
  const idem = await set(B, true, "mesma situação de novo");
  ck("3.5 repetir a mesma autorização continua idempotente (sem novo evento), mas ainda exige motivo", idem.ok && idem.rows[0].j.changed === false && (await evs(B)).length === 3 && (await set(B, true, "")).code === "PT400");
  const revNone = await set(C, false, "revogando quem nunca foi autorizado");
  ck("3.6 revogar empresa fora da allowlist: sem efeito, sem linha nem evento", revNone.ok && revNone.rows[0].j.changed === false && (await rows(C)).length === 0 && (await evs(C)).length === 0);
}

console.log("\n== 4. segurança preservada ==");
ck("4.1 owner da empresa, anon e service_role NÃO executam (mesmo com motivo válido)",
  !(await as("authenticated", owner, "select public.master_whatsapp_pilot_set($1,true,'motivo válido')", [C])).ok
  && !(await as("anon", null, "select public.master_whatsapp_pilot_set($1,true,'motivo válido')", [C])).ok
  && !(await as("service_role", null, "select public.master_whatsapp_pilot_set($1,true,'motivo válido')", [C])).ok && (await rows(C)).length === 0);
ck("4.2 usuário comum recebe a recusa de administrador (não a de validação) mesmo com motivo vazio", /administradores/.test((await as("authenticated", owner, "select public.master_whatsapp_pilot_set($1,true,'')", [C])).err ?? ""));
ck("4.3 empresa inexistente continua PT404 e parâmetros nulos PT400", (await set(id(999999), true, "motivo válido")).code === "PT404" && (await set(null, true, "motivo válido")).code === "PT400" && (await set(A, null, "motivo válido")).code === "PT400");
{
  const r = (await su(`select count(*) over () n, p.prosecdef sd, coalesce(p.proconfig::text,'') cfg, has_function_privilege('anon',p.oid,'execute') a, has_function_privilege('authenticated',p.oid,'execute') u, has_function_privilege('service_role',p.oid,'execute') s from pg_proc p where p.proname='master_whatsapp_pilot_set'`)).rows;
  ck("4.4 uma única função (sem sobrecarga), SECURITY DEFINER, search_path fixo, EXECUTE só authenticated", r.length === 1 && r[0].sd && /search_path=public/.test(r[0].cfg) && !r[0].a && r[0].u && !r[0].s);
}
ck("4.5 funções irmãs intactas: list e events seguem exigindo Admin Master e funcionando",
  (await M("select public.master_whatsapp_pilot_list() j")).rows[0].j.length === 2 && (await M("select public.master_whatsapp_pilot_events($1) j", [B])).rows[0].j.length === 3
  && !(await as("authenticated", owner, "select public.master_whatsapp_pilot_list()")).ok && !(await as("authenticated", owner, "select public.master_whatsapp_pilot_events($1)", [B])).ok);

console.log("\n== 5. revogação encerra sessões em andamento ==");
{
  const D = await mk(4);
  await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,'owner','active')", [D, owner]);
  await set(D, true, "piloto D");
  await su("insert into whatsapp_signup_sessions (company_id, user_id, state_hash) values ($1,$2,encode(sha256(convert_to('s5','UTF8')),'hex'))", [D, owner]);
  const bad = await set(D, false, "x");
  const still = (await su("select status from whatsapp_signup_sessions where company_id=$1", [D])).rows[0].status;
  const ok = await set(D, false, "retirada do piloto");
  const now = (await su("select status from whatsapp_signup_sessions where company_id=$1", [D])).rows[0].status;
  ck("5.1 revogação recusada por motivo curto não mexe na sessão; revogação válida a encerra", !bad.ok && still === "pending" && ok.ok && ok.rows[0].j.sessions_closed === 1 && now === "failed");
}
summary("NOTA OBRIGATÓRIA DO PILOTO (ETAPA 10.1)");
