// 20261106010000: PIN individual por número no Vault, estado/auditoria do registro na Meta, limite de tentativas, PIN do cliente,
// revelação em duas etapas (autorização do usuário + consumo único do backend), limpeza de PINs abandonados, ACL e isolamento.
import { loadAll } from "./full-db.mjs";
const { pg, ck, as, su: su0, errHas, summary } = await loadAll(undefined, { legacyIaMirror: false });
const su = async (sql, params) => { await pg.exec("select set_config('request.jwt.claim.sub','',false)"); return su0(sql, params); };
const U = (uid) => (sql, params) => as("authenticated", uid, sql, params);
const svc = (sql, params) => as("service_role", null, sql, params);
const anon = (sql, params) => as("anon", null, sql, params);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await pg.exec(`
  drop table if exists vault.decrypted_secrets;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, description text, secret text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $f$
  declare v uuid; begin insert into vault.secrets (name, description, secret) values (new_secret, new_name, new_description) returning id into v; return v; end $f$;
`.replace("values (new_secret, new_name, new_description)", "values (new_name, new_description, new_secret)"));
await su("update whatsapp_platform_settings set embedded_signup_enabled=true, meta_app_id='1234567890', embedded_signup_config_id='9876543210'");

let seq = 1200, pn = 950000000;
async function mkCo(tag, { wa = true } = {}) {
  const c = (await su("insert into companies (name,slug,document,email) values ($1,$2,'11222333000181',$3) returning id", ["Emp " + tag, "pn-" + tag.toLowerCase(), `${tag.toLowerCase()}@x.com`])).rows[0].id;
  await su("insert into whatsapp_signup_pilot_companies (company_id, authorized, authorized_at) values ($1, true, now())", [c]);
  const out = { c, ids: {}, pnid: String(++pn) };
  for (const role of ["owner", "admin", "attendant"]) {
    const u = id(++seq);
    await su(`insert into auth.users (id,email) values ('${u}','${role}-${tag}@x.com')`);
    await su(`insert into public.profiles (user_id,email,full_name) values ('${u}','${role}-${tag}@x.com','${role} ${tag}') on conflict (user_id) do update set full_name = excluded.full_name`);
    await su("insert into company_users (company_id,user_id,role,status) values ($1,$2,$3,'active')", [c, u, role]);
    out[role] = U(u); out.ids[role] = u;
  }
  if (wa) await su("insert into company_module_overrides (company_id, module_code, reason, expires_at) values ($1,'whatsapp','teste pin registro', now() + interval '1 day')", [c]);
  return out;
}
const secretOf = async (sid) => (await su("select secret from vault.secrets where id=$1", [sid])).rows[0]?.secret ?? null;
const reg = async (rid) => (await su("select * from whatsapp_number_registrations where id=$1", [rid])).rows[0];
async function session(co, { role = "owner" } = {}) {
  const state = (await co[role]("select public.whatsapp_signup_begin($1) j", [co.c])).rows[0].j.state;
  const r = (await svc("select public.whatsapp_signup_reserve($1) j", [state])).rows[0].j;
  return r.session_id;
}
const prepare = async (sid, pnid, waba = "555000111222") => (await svc("select public.whatsapp_registration_prepare($1,$2,$3) j", [sid, pnid, waba])).rows?.[0]?.j;
const store = async (sid, rid, pin, src = "generated") => (await svc("select public.whatsapp_registration_store_pin($1,$2,$3,$4) j", [sid, rid, pin, src])).rows?.[0]?.j;
const begin = async (sid, rid) => (await svc("select public.whatsapp_registration_begin_attempt($1,$2) j", [sid, rid])).rows?.[0]?.j;
const finish = async (aid, outcome, code = null) => (await svc("select public.whatsapp_registration_finish_attempt($1,$2,$3) j", [aid, outcome, code])).rows?.[0]?.j;
/** prepara + guarda PIN + abre tentativa: devolve ids prontos para finish */
async function ready(co, pin = "123456", pnid = co.pnid) {
  const sid = await session(co);
  const p = await prepare(sid, pnid);
  await store(sid, p.registration_id, pin);
  const b = await begin(sid, p.registration_id);
  return { sid, rid: p.registration_id, aid: b.attempt_id, p };
}
const aged = async (rid, interval) => { await pg.exec("select set_config('session_replication_role','replica',false)"); await su(`update whatsapp_number_registrations set updated_at = now() - interval '${interval}' where id=$1`, [rid]); await pg.exec("select set_config('session_replication_role','origin',false)"); };
const clearAttempts = (rid) => su("delete from whatsapp_registration_attempts where registration_id=$1", [rid]);
const setClaims = async (claims) => pg.exec(`select set_config('request.jwt.claims', '${claims === null ? "" : JSON.stringify(claims)}', false)`);
const freshAmr = () => ({ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 30 }] });

const A = await mkCo("A"), B = await mkCo("B"), NOWA = await mkCo("N", { wa: false });

console.log("\n== 1. estrutura, RLS e ACL ==");
const t = (await su(`select c.relname, c.relrowsecurity rls, has_table_privilege('authenticated', c.oid, 'select') au, has_table_privilege('anon', c.oid, 'select') an
  from pg_class c where c.relname in ('whatsapp_number_registrations','whatsapp_registration_attempts','whatsapp_pin_reveal_requests') and c.relnamespace='public'::regnamespace`)).rows;
ck("1.1 três tabelas novas: RLS ligada e nenhum acesso de anon/authenticated", t.length === 3 && t.every((r) => r.rls && !r.au && !r.an), JSON.stringify(t));
const fns = (await su(`select p.proname, p.prosecdef, p.proconfig::text cfg, has_function_privilege('anon',p.oid,'execute') a, has_function_privilege('authenticated',p.oid,'execute') au, has_function_privilege('service_role',p.oid,'execute') s
  from pg_proc p where pronamespace='public'::regnamespace and proname in ('whatsapp_registration_prepare','whatsapp_registration_store_pin','whatsapp_registration_begin_attempt','whatsapp_registration_finish_attempt','whatsapp_registration_resolve','whatsapp_registration_link','whatsapp_pin_reveal_authorize','whatsapp_pin_reveal_consume','whatsapp_registration_sweep','whatsapp_registration_check_session','whatsapp_registration_drop_secret')`)).rows;
const by = Object.fromEntries(fns.map((r) => [r.proname, r]));
ck("1.2 11 funções, todas SECURITY DEFINER com search_path fixo", fns.length === 11 && fns.every((r) => r.prosecdef && /search_path=public/.test(r.cfg)));
ck("1.3 operações de registro e consumo: só service_role", ["whatsapp_registration_prepare", "whatsapp_registration_store_pin", "whatsapp_registration_begin_attempt", "whatsapp_registration_finish_attempt", "whatsapp_registration_resolve", "whatsapp_registration_link", "whatsapp_pin_reveal_consume", "whatsapp_registration_sweep"].every((n) => by[n].s && !by[n].au && !by[n].a));
ck("1.4 autorização da revelação: só authenticated; helpers internos: ninguém", by.whatsapp_pin_reveal_authorize.au && !by.whatsapp_pin_reveal_authorize.s && !by.whatsapp_pin_reveal_authorize.a
  && ["whatsapp_registration_check_session", "whatsapp_registration_drop_secret"].every((n) => !by[n].s && !by[n].au && !by[n].a));
ck("1.5 as únicas funções que devolvem PIN (begin_attempt e reveal_consume) são service_role-only; não existe leitura avulsa de PIN", ["whatsapp_registration_begin_attempt", "whatsapp_pin_reveal_consume"].every((n) => by[n].s && !by[n].au && !by[n].a) && !by.whatsapp_registration_get_pin);

console.log("\n== 2. preparar o registro ==");
const sA = await session(A);
const p1 = await prepare(sA, A.pnid);
ck("2.1 número novo: ação 'register', sem PIN guardado, registro da empresa da sessão", p1.ok && p1.action === "register" && p1.has_stored_pin === false && p1.state === "pending" && (await reg(p1.registration_id)).company_id === A.c);
const p1b = await prepare(sA, A.pnid);
ck("2.2 repetir é idempotente (mesmo registro)", p1b.registration_id === p1.registration_id && Number((await su("select count(*) n from whatsapp_number_registrations where phone_number_id=$1", [A.pnid])).rows[0].n) === 1);
const sB = await session(B);
ck("2.3 número de outra empresa: phone_in_use, sem tocar no registro dela", (await prepare(sB, A.pnid)).error === "phone_in_use" && (await reg(p1.registration_id)).company_id === A.c);
ck("2.4 sessão inexistente / não reservada: erro", (await prepare("00000000-0000-4000-8000-0000000000aa", A.pnid)).error === "session_not_found"
  && (await prepare((await su("select id from whatsapp_signup_sessions where company_id=$1 limit 1", [NOWA.c])).rows[0]?.id ?? "00000000-0000-4000-8000-0000000000ab", A.pnid)).ok === false);
ck("2.5 id inválido: PT400", errHas(await svc("select public.whatsapp_registration_prepare($1,'12',null) j", [sA]), /inválidos/, "PT400"));
ck("2.6 prepare sem sessão pendente: a sessão precisa estar reservada", await (async () => {
  const state = (await B.owner("select public.whatsapp_signup_begin($1) j", [B.c])).rows[0].j.state; // pending, não reservada
  const sid = (await su("select id from whatsapp_signup_sessions where state_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [state])).rows[0].id;
  return (await prepare(sid, B.pnid)).error === "session_not_reserved";
})());

console.log("\n== 3. PIN individual no Vault ==");
const rid = p1.registration_id;
const stA = await store(sA, rid, "000123", "generated");
const rowA = await reg(rid);
ck("3.1 PIN com zero à esquerda guardado integralmente no Vault; a tabela só tem a referência", stA.ok && (await secretOf(rowA.pin_secret_id)) === "000123" && rowA.pin_source === "generated" && !JSON.stringify(rowA).includes("000123"));
ck("3.2 nome do segredo: wa_pin_<registro>_*", (await su("select name from vault.secrets where id=$1", [rowA.pin_secret_id])).rows[0].name.startsWith(`wa_pin_${rid}_`));
ck("3.3 formato inválido: PT400 (5 dígitos, letras, 7 dígitos, vazio, fonte inválida)", ["12345", "12345a", "1234567", "", "12 456"].every(async () => true)
  && (await Promise.all(["12345", "12345a", "1234567", "", "12 456"].map((p) => svc("select public.whatsapp_registration_store_pin($1,$2,$3,'generated') j", [sA, rid, p])))).every((r) => errHas(r, /PIN inválido/, "PT400"))
  && errHas(await svc("select public.whatsapp_registration_store_pin($1,$2,'123456','outro') j", [sA, rid]), /PIN inválido/, "PT400"));
{
  const N3 = await mkCo("N3");
  const sid = await session(N3);
  const p = await prepare(sid, N3.pnid);
  await store(sid, p.registration_id, "000123");
  const bb = await begin(sid, p.registration_id);
  ck("3.4 a tentativa devolve o PIN do Vault (zero à esquerda preservado) ao backend", bb.ok && bb.pin === "000123" && bb.pin_source === "generated");
  await finish(bb.attempt_id, "failed", "131000");
}
const sB2 = await session(B);
ck("3.5 outra empresa não abre tentativa nem grava PIN no registro (registration_not_found)", (await begin(sB2, rid)).error === "registration_not_found" && (await store(sB2, rid, "999999")).error === "registration_not_found" && (await secretOf(rowA.pin_secret_id)) === "000123");
const pB = await prepare(sB2, B.pnid);
await store(sB2, pB.registration_id, "654321");
ck("3.6 PINs diferentes por número e por empresa, cada um no seu segredo", (await secretOf((await reg(pB.registration_id)).pin_secret_id)) === "654321" && (await reg(pB.registration_id)).pin_secret_id !== rowA.pin_secret_id);
const oldRef = rowA.pin_secret_id;
await store(sA, rid, "247135", "customer");
ck("3.7 PIN do cliente substitui o candidato ainda não registrado cria segredo novo e apaga o antigo", (await reg(rid)).pin_secret_id !== oldRef && (await secretOf(oldRef)) === null && (await secretOf((await reg(rid)).pin_secret_id)) === "247135");
const noOverwrite = await store(sA, rid, "999111", "generated");
ck("3.7b PIN GERADO nunca substitui um PIN já guardado (pin_already_stored), o Vault não muda", noOverwrite.error === "pin_already_stored" && (await secretOf((await reg(rid)).pin_secret_id)) === "247135");
const leakScan = (await su(`select (select count(*) from whatsapp_number_registrations r where r::text like '%247135%' or r::text like '%654321%')
  + (select count(*) from whatsapp_registration_attempts a where a::text like '%247135%')
  + (select count(*) from whatsapp_signup_sessions s where s::text like '%247135%') n`)).rows[0].n;
ck("3.8 PIN em texto puro não aparece em nenhuma tabela pública", Number(leakScan) === 0);

console.log("\n== 4. tentativa de registro, estados e limites ==");
const sA2 = await session(A);
const b1 = await begin(sA2, rid);
ck("4.1 tentativa aberta; registro vai para in_progress; auditoria sem PIN", b1.ok && (await reg(rid)).state === "in_progress" && (await su("select * from whatsapp_registration_attempts where id=$1", [b1.attempt_id])).rows[0].status === "started");
ck("4.2 segunda tentativa simultânea: registration_in_progress", (await begin(sA2, rid)).error === "registration_in_progress");
const f1 = await finish(b1.attempt_id, "success");
ck("4.3 sucesso: registered com data; bloqueios limpos", f1.ok && f1.state === "registered" && !!(await reg(rid)).registered_at && (await reg(rid)).blocked_until === null);
ck("4.4 finalizar de novo é idempotente (não muda o estado)", (await finish(b1.attempt_id, "failed")).idempotent === true && (await reg(rid)).state === "registered");
const sA3 = await session(A);
const pr = await prepare(sA3, A.pnid);
ck("4.5 reconexão com registro concluído: ação 'skip' (não gasta a cota da Meta), com a data do registro", pr.action === "skip" && !!pr.registered_at);
ck("4.6 registrado: nova tentativa recusada e PIN nunca sobrescrito", (await begin(sA3, rid)).error === "already_registered" && (await store(sA3, rid, "999999")).error === "state_not_allowed" && (await secretOf((await reg(rid)).pin_secret_id)) === "247135");
ck("4.7 registro concluído não devolve PIN em tentativa (a recuperação é só pela revelação autorizada)", (await begin(sA3, rid)).pin === undefined);

const C = await mkCo("C");
{
  // limite próprio: 3 tentativas por número em 72 h
  const sid = await session(C);
  const p = await prepare(sid, C.pnid);
  await store(sid, p.registration_id, "222333");
  const outs = [];
  for (let i = 0; i < 3; i++) { const b = await begin(sid, p.registration_id); outs.push(b.ok); await finish(b.attempt_id, "failed", "131000"); }
  const b4 = await begin(sid, p.registration_id);
  ck("4.8 3 tentativas ok e a 4ª em 72 h: attempts_exhausted com retry_after", outs.every(Boolean) && b4.error === "attempts_exhausted" && !!b4.retry_after);
  await su("update whatsapp_registration_attempts set started_at = now() - interval '73 hours' where registration_id=$1", [p.registration_id]);
  ck("4.9 passadas 72 h as tentativas voltam a ser permitidas", (await begin(sid, p.registration_id)).ok === true);
}
{
  const D = await mkCo("D");
  const { rid: r, sid } = await ready(D, "333444");
  ck("4.10 falha definitiva (failed): estado failed, código gravado, PIN mantido para nova tentativa", await (async () => { const a = (await su("select id from whatsapp_registration_attempts where registration_id=$1", [r])).rows[0].id; const f = await finish(a, "failed", "133004"); const row = await reg(r); const pr2 = await prepare(await session(D), D.pnid); return f.state === "failed" && row.last_error_code === "133004" && !!row.pin_secret_id && pr2.action === "register" && pr2.has_stored_pin === true; })());
  const sid2 = await session(D);
  const g = await begin(sid2, r);
  ck("4.11 a nova tentativa reaproveita O MESMO PIN guardado", g.ok && g.pin === "333444");
}
{
  const E = await mkCo("E");
  const { rid: r, aid } = await ready(E, "444555");
  await finish(aid, "uncertain");
  const sid = await session(E);
  ck("4.12 resultado incerto: prepare e begin recusam (registration_uncertain) — sem retentativa automática", (await prepare(sid, E.pnid)).error === "registration_uncertain" && (await begin(sid, r)).error === "registration_uncertain");
  ck("4.13 resolve (operador, após conferir): registered libera; e fica auditado", (await svc("select public.whatsapp_registration_resolve($1,'registered') j", [r])).rows[0].j.ok === true && (await reg(r)).state === "registered"
    && (await su("select count(*) n from whatsapp_registration_attempts where registration_id=$1 and status='manual_registered'", [r])).rows[0].n == 1);
  ck("4.14 resolve só vale para uncertain/in_progress; outcome inválido: PT400; cliente não executa", (await svc("select public.whatsapp_registration_resolve($1,'failed') j", [r])).rows[0].j.error === "state_not_allowed"
    && errHas(await svc("select public.whatsapp_registration_resolve($1,'x') j", [r]), /inválido/, "PT400") && !(await E.owner("select public.whatsapp_registration_resolve($1,'failed') j", [r])).ok);
}
{
  const F = await mkCo("F");
  const { rid: r } = await ready(F, "555666");
  await aged(r, '5 minutes');
  const sid = await session(F);
  ck("4.15 chamada 'in_progress' sem resposta há 2+ min vira uncertain (nunca retenta sozinha)", (await prepare(sid, F.pnid)).error === "registration_uncertain" && (await reg(r)).state === "uncertain");
}

{
  const FF = await mkCo("FF");
  const sid = await session(FF);
  const p = await prepare(sid, FF.pnid);
  await store(sid, p.registration_id, "616161");
  await su("update vault.secrets set secret='abc' where id=$1", [(await reg(p.registration_id)).pin_secret_id]);
  ck("4.16 segredo do Vault corrompido (não é PIN de 6 dígitos): begin_attempt recusa (pin_not_available) e não abre tentativa", (await begin(sid, p.registration_id)).error === "pin_not_available" && (await reg(p.registration_id)).state === "pending");
}

console.log("\n== 5. erros da Meta: PIN incorreto, limites e PIN do cliente ==");
{
  const G = await mkCo("G");
  const { rid: r, aid, sid } = await ready(G, "666777");
  const oldSecret = (await reg(r)).pin_secret_id;
  const f = await finish(aid, "pin_incorrect", "133005");
  const row = await reg(r);
  ck("5.1 133005: estado pin_required; o PIN gerado (errado) é apagado do Vault; nada é sobrescrito na Meta", f.state === "pin_required" && row.pin_secret_id === null && row.pin_source === null && (await secretOf(oldSecret)) === null && row.last_error_code === "133005");
  const s2 = await session(G);
  const p2 = await prepare(s2, G.pnid);
  ck("5.2 prepare passa a exigir o PIN do cliente (need_customer_pin) e begin recusa sem PIN", p2.action === "need_customer_pin" && (await begin(s2, r)).error === "pin_required");
  const stc = await store(s2, r, "010203", "customer");
  ck("5.3 PIN do cliente guardado no Vault (fonte customer) e o registro volta a pending", stc.ok && (await reg(r)).pin_source === "customer" && (await secretOf((await reg(r)).pin_secret_id)) === "010203" && (await reg(r)).state === "pending");
  const b = await begin(s2, r);
  const f2 = await finish(b.attempt_id, "success");
  ck("5.4 registro com o PIN do cliente conclui; o PIN do cliente permanece como o do número", f2.state === "registered" && (await secretOf((await reg(r)).pin_secret_id)) === "010203");
}
{
  const H = await mkCo("H");
  const { rid: r, aid, sid } = await ready(H, "777888");
  await finish(aid, "pin_incorrect", "133005");
  const s2 = await session(H);
  await prepare(s2, H.pnid);
  await store(s2, r, "999000", "customer");
  const b = await begin(s2, r);
  await finish(b.attempt_id, "pin_incorrect", "133005");
  ck("5.5 PIN do cliente incorreto: descartado, volta a pin_required (2 tentativas auditadas, sem PIN nos registros)", (await reg(r)).state === "pin_required" && (await reg(r)).pin_secret_id === null
    && Number((await su("select count(*) n from whatsapp_registration_attempts where registration_id=$1 and status='pin_incorrect'", [r])).rows[0].n) === 2);
}
{
  const I = await mkCo("I");
  const { rid: r, aid } = await ready(I, "121212");
  await finish(aid, "rate_limited", "133016");
  const row = await reg(r);
  const sid = await session(I);
  ck("5.6 133016: bloqueado por 72 h; prepare/begin recusam com blocked_until", row.state === "blocked" && Math.abs((new Date(row.blocked_until) - Date.now()) / 3600e3 - 72) < 0.1
    && (await prepare(sid, I.pnid)).error === "registration_blocked" && (await begin(sid, r)).error === "registration_blocked");
  await su("update whatsapp_number_registrations set blocked_until = now() - interval '1 minute' where id=$1", [r]);
  await clearAttempts(r);
  const p = await prepare(sid, I.pnid);
  ck("5.7 bloqueio vencido por 133016: volta a 'register' reaproveitando o PIN guardado", p.ok && p.action === "register" && p.has_stored_pin === true && (await reg(r)).blocked_until === null);
}
{
  const J = await mkCo("J");
  const { rid: r, aid } = await ready(J, "131313");
  const ref = (await reg(r)).pin_secret_id;
  await finish(aid, "too_many_guesses", "133008");
  const row = await reg(r);
  ck("5.8 133008: bloqueado 1 h e o PIN usado (errado) é descartado do Vault", row.state === "blocked" && Math.abs((new Date(row.blocked_until) - Date.now()) / 3600e3 - 1) < 0.05 && row.pin_secret_id === null && (await secretOf(ref)) === null);
  await su("update whatsapp_number_registrations set blocked_until = now() - interval '1 minute' where id=$1", [r]);
  const p = await prepare(await session(J), J.pnid);
  ck("5.9 bloqueio vencido por excesso de palpites: exige o PIN do cliente (não tenta gerar outro às cegas)", p.action === "need_customer_pin");
}
ck("5.10 finish com resultado inválido: PT400; código com formato inválido é normalizado", await (async () => {
  const K = await mkCo("K"); const { aid, rid: r } = await ready(K, "141414");
  const bad = errHas(await svc("select public.whatsapp_registration_finish_attempt($1,'inventado') j", [aid]), /inválido/, "PT400");
  await finish(aid, "failed", "codigo com espaco; drop");
  return bad && (await reg(r)).last_error_code === "invalid_code";
})());

console.log("\n== 6. associação com a conexão (link) ==");
{
  const L = await mkCo("L");
  const sid = await session(L);
  const p = await prepare(sid, L.pnid);
  await store(sid, p.registration_id, "151515");
  const b = await begin(sid, p.registration_id);
  await finish(b.attempt_id, "success");
  await su("select 1"); // tokens do signup
  await svc("select public.whatsapp_signup_store_token($1,'TOKEN-DE-TESTE-DO-SIGNUP-0001') j", [sid]);
  const c = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55 11 9','Emp','444555666',now(),now(),'cloud_api') j", [sid, L.pnid])).rows[0].j;
  const lk = (await svc("select public.whatsapp_registration_link($1,$2) j", [sid, p.registration_id])).rows[0].j;
  ck("6.1 link associa o registro à conexão criada pela sessão concluída", c.ok && lk.ok && (await reg(p.registration_id)).connection_id === c.connection_id);
  const M = await mkCo("M");
  const sM = await session(M);
  ck("6.2 link recusa sessão não concluída e registro de outra empresa", (await svc("select public.whatsapp_registration_link($1,$2) j", [sM, p.registration_id])).rows[0].j.error === "cannot_link"
    && (await svc("select public.whatsapp_registration_link($1,$2) j", [sid, (await prepare(sM, M.pnid)).registration_id])).rows[0].j.error === "cannot_link");
  ck("6.3 link só para service_role", !(await L.owner("select public.whatsapp_registration_link($1,$2) j", [sid, p.registration_id])).ok);
}

console.log("\n== 7. revelação do PIN (autorização do usuário + consumo único do backend) ==");
const R = await mkCo("R");
const rsid = await session(R);
const rp = await prepare(rsid, R.pnid);
await store(rsid, rp.registration_id, "909090");
{ const b = await begin(rsid, rp.registration_id); await finish(b.attempt_id, "success"); }
await svc("select public.whatsapp_signup_store_token($1,'TOKEN-DE-TESTE-DO-SIGNUP-0002') j", [rsid]);
const rc = (await svc("select public.whatsapp_signup_complete($1,'555000111222',$2,'+55 11 9','Emp','444555666',now(),now(),'cloud_api') j", [rsid, R.pnid])).rows[0].j;
const auth = (co, role, reason = "Cliente pediu o PIN para migrar o número") => co[role]("select public.whatsapp_pin_reveal_authorize($1,$2) j", [rc.connection_id, reason]);
await setClaims(freshAmr());
const g1 = await auth(R, "owner");
ck("7.1 owner com login recente recebe só um ticket (grant_id + validade), SEM PIN", g1.ok && !!g1.rows[0].j.grant_id && !!g1.rows[0].j.expires_at && !JSON.stringify(g1.rows[0].j).includes("909090") && Object.keys(g1.rows[0].j).sort().join() === "expires_at,grant_id");
const rowG = (await su("select * from whatsapp_pin_reveal_requests where id=$1", [g1.rows[0].j.grant_id])).rows[0];
ck("7.2 auditoria: quem pediu, empresa, motivo e validade de 2 min; sem PIN", rowG.requested_by === R.ids.owner && rowG.company_id === R.c && /migrar/.test(rowG.reason) && rowG.status === "authorized" && Math.abs((new Date(rowG.expires_at) - new Date(rowG.created_at)) / 60000 - 2) < 0.1 && !JSON.stringify(rowG).includes("909090"));
ck("7.3 admin também pode; attendant PT403; outra empresa PT404", (await auth(R, "admin")).ok && errHas(await auth(R, "attendant"), /proprietário ou administrador/, "PT403") && errHas(await auth(B, "owner"), /não encontrada/i, "PT404"));
ck("7.4 motivo curto/vazio: PT400", errHas(await auth(R, "owner", "x"), /motivo/i, "PT400") && errHas(await auth(R, "owner", ""), /motivo/i, "PT400"));
ck("7.5 anon e service_role não chamam a autorização", !(await anon("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [rc.connection_id])).ok && !(await svc("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [rc.connection_id])).ok);
await setClaims(null);
ck("7.6 sem claims de login recente (JWT sem amr): PT401 'confirme sua senha'", errHas(await auth(R, "owner"), /Confirme sua senha/, "PT401"));
await setClaims({ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 3600 }] });
ck("7.7 login com mais de 5 min: PT401", errHas(await auth(R, "owner"), /Confirme sua senha/, "PT401"));
await setClaims({ amr: "x" });
ck("7.8 claims malformadas: PT401 (falha fechada)", errHas(await auth(R, "owner"), /Confirme sua senha/, "PT401"));
await setClaims(freshAmr());
// consumo
const pickGrant = async () => { await su("update whatsapp_pin_reveal_requests set status='expired' where company_id=$1 and status='authorized'", [R.c]); await su("delete from whatsapp_pin_reveal_requests where company_id=$1", [R.c]); const g = await auth(R, "owner"); return g.rows[0].j.grant_id; };
const grant = await pickGrant();
const cons = (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [grant, R.ids.owner])).rows[0].j;
ck("7.9 consumo pelo backend entrega o PIN uma vez ao mesmo usuário", cons.ok && cons.pin === "909090");
ck("7.10 segundo consumo do mesmo ticket: grant_used", (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [grant, R.ids.owner])).rows[0].j.error === "grant_used");
ck("7.11 ticket consumido fica auditado (consumed_at) e sem PIN", await (async () => { const r = (await su("select * from whatsapp_pin_reveal_requests where id=$1", [grant])).rows[0]; return r.status === "consumed" && !!r.consumed_at && !JSON.stringify(r).includes("909090"); })());
{
  const g = await pickGrant();
  ck("7.12 ticket de outro usuário não vale (grant_not_found)", (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [g, R.ids.admin])).rows[0].j.error === "grant_not_found");
  await su("update whatsapp_pin_reveal_requests set created_at = now() - interval '10 minutes', expires_at = now() - interval '8 minutes' where id=$1", [g]);
  ck("7.13 ticket vencido: grant_expired", (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [g, R.ids.owner])).rows[0].j.error === "grant_expired");
}
{
  const g = await pickGrant();
  await su("update company_users set role='attendant' where company_id=$1 and user_id=$2", [R.c, R.ids.admin]);
  const gAdmin = (await R.admin("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [rc.connection_id]));
  ck("7.14 papel rebaixado: nem autoriza (PT403)", !gAdmin.ok);
  await su("update company_users set role='admin' where company_id=$1 and user_id=$2", [R.c, R.ids.admin]);
  // dono do ticket perde o papel ENTRE autorizar e consumir
  const gOwner = await R.admin("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [rc.connection_id]);
  await su("update company_users set status='inactive' where company_id=$1 and user_id=$2", [R.c, R.ids.admin]);
  ck("7.15 usuário desativado entre autorizar e consumir: unauthorized e nada entregue", (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [gOwner.rows?.[0]?.j?.grant_id ?? g, R.ids.admin])).rows[0].j.ok !== true);
  await su("update company_users set status='active' where company_id=$1 and user_id=$2", [R.c, R.ids.admin]);
}
ck("7.16 consumo só pelo service_role", !(await R.owner("select public.whatsapp_pin_reveal_consume($1,$2) j", [grant, R.ids.owner])).ok && !(await anon("select public.whatsapp_pin_reveal_consume($1,$2) j", [grant, R.ids.owner])).ok);
await su("delete from whatsapp_pin_reveal_requests where company_id=$1", [R.c]);
for (let i = 0; i < 3; i++) await auth(R, "owner");
ck("7.17 limite de consultas: 3 por hora por empresa (PT429)", errHas(await auth(R, "owner"), /Limite de consultas/, "PT429"));
await su("update whatsapp_pin_reveal_requests set created_at = now() - interval '2 hours' where company_id=$1", [R.c]);
{
  await su("delete from whatsapp_pin_reveal_requests where company_id=$1", [R.c]);
  await su("insert into whatsapp_pin_reveal_requests (company_id, registration_id, requested_by, reason, status, created_at, expires_at) select $1, $2, $3, 'motivo antigo teste', 'expired', now() - interval '3 hours', now() - interval '3 hours' + interval '2 minutes' from generate_series(1,10)", [R.c, rp.registration_id, R.ids.owner]);
  ck("7.18 limite diário por usuário: 10 em 24 h (PT429)", errHas(await auth(R, "owner"), /Limite de consultas/, "PT429"));
}
await su("delete from whatsapp_pin_reveal_requests where company_id=$1", [R.c]);
{
  const g1x = (await auth(R, "owner")).rows[0].j.grant_id;
  const g2x = (await auth(R, "owner")).rows[0].j.grant_id;
  ck("7.19 novo pedido invalida o ticket anterior ainda aberto", (await su("select status from whatsapp_pin_reveal_requests where id=$1", [g1x])).rows[0].status === "expired" && (await svc("select public.whatsapp_pin_reveal_consume($1,$2) j", [g1x, R.ids.owner])).rows[0].j.error === "grant_used" && (await su("select status from whatsapp_pin_reveal_requests where id=$1", [g2x])).rows[0].status === "authorized");
}
{
  // sem PIN guardado (conexão manual antiga): nada a revelar
  const old = (await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id) values ($1,'disconnected','test','960000001') returning id", [B.c])).rows[0].id;
  await su("update company_whatsapp_connections set status='disconnected' where id=$1", [old]);
  ck("7.20 conexão antiga sem registro/PIN: PT404 'não há PIN guardado'", errHas(await B.owner("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [old]), /Não há PIN/, "PT404"));
}
ck("7.21 sem módulo WhatsApp: PT403", await (async () => { const c = (await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id) values ($1,'disconnected','test','960000002') returning id", [NOWA.c])).rows[0].id; return errHas(await NOWA.owner("select public.whatsapp_pin_reveal_authorize($1,'motivo válido aqui') j", [c]), /não está contratado/, "PT403"); })());
await setClaims(null);

console.log("\n== 8. limpeza de PINs abandonados ==");
{
  const mk = async (tag, state, { age = "10 days", withConn = false } = {}) => {
    const co = await mkCo(tag);
    const sid = await session(co);
    const p = await prepare(sid, co.pnid);
    await store(sid, p.registration_id, "181818");
    const ref = (await reg(p.registration_id)).pin_secret_id;
    if (state === "registered") await su("update whatsapp_number_registrations set state='registered', registered_at=now() where id=$1", [p.registration_id]);
    else if (state === "blocked") await su("update whatsapp_number_registrations set state='blocked', blocked_until=now() + interval '1 day' where id=$1", [p.registration_id]);
    else if (state !== "pending") await su("update whatsapp_number_registrations set state=$2 where id=$1", [p.registration_id, state]);
    if (withConn) await su("insert into company_whatsapp_connections (company_id,status,phone_number_id) values ($1,'disconnected',$2)", [co.c, co.pnid]);
    return { rid: p.registration_id, ref, age };
  };
  const a = await mk("S1", "pending"), b = await mk("S2", "failed"), c = await mk("S3", "pin_required");
  const keepers = [await mk("S4", "registered"), await mk("S5", "uncertain"), await mk("S6", "in_progress"), await mk("S7", "blocked"), await mk("S8", "pending", { age: "1 day" }), await mk("S9", "failed", { withConn: true })];
  // envelhece só depois de criar todos (criar uma sessão já dispara a varredura da própria rotina)
  for (const x of [a, b, c, ...keepers]) await aged(x.rid, x.age);
  const sw = (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j;
  ck("8.1 sweep remove o PIN de registros parados (pending/failed/pin_required) há 7+ dias e sem conexão", sw.ok && sw.pins_removed === 3 && [a, b, c].every((x) => true)
    && (await secretOf(a.ref)) === null && (await secretOf(b.ref)) === null && (await secretOf(c.ref)) === null && (await reg(a.rid)).pin_secret_id === null && (await reg(a.rid)).pin_source === null);
  ck("8.2 nunca remove: registered, uncertain, in_progress, blocked, recentes (<7 dias) ou com conexão", (await Promise.all(keepers.map((k) => secretOf(k.ref)))).every((v) => v === "181818"));
  ck("8.3 varredura é idempotente", (await svc("select public.whatsapp_registration_sweep() j")).rows[0].j.pins_removed === 0);
  const foreign = (await su("insert into vault.secrets (name, secret) values ('wa_token_manual_antigo','TOKEN-ANTIGO-NAO-APAGAR') returning id")).rows[0].id;
  const d = await mk("S10", "pending");
  await aged(d.rid, d.age);
  await su("update whatsapp_number_registrations set pin_secret_id=$1 where id=$2", [foreign, d.rid]);
  await aged(d.rid, d.age);
  await svc("select public.whatsapp_registration_sweep() j");
  ck("8.4 trava de nome: segredo fora do prefixo wa_pin_ nunca é apagado (só a referência é limpa)", (await secretOf(foreign)) === "TOKEN-ANTIGO-NAO-APAGAR" && (await reg(d.rid)).pin_secret_id === null);
  const tok = (await su("select count(*) n from vault.secrets where name like 'wa_token%'")).rows[0].n;
  ck("8.5 tokens (wa_token_*) e segredos de conexões não são afetados pela limpeza de PIN", Number(tok) >= 1);
}
{
  const X = await mkCo("X");
  const sid = await session(X);
  const p = await prepare(sid, X.pnid);
  await store(sid, p.registration_id, "191919");
  const ref = (await reg(p.registration_id)).pin_secret_id;
  const other = (await su("select pin_secret_id from whatsapp_number_registrations where id=$1", [rid])).rows[0].pin_secret_id;
  await su("delete from companies where id=$1", [X.c]);
  const Y = await mkCo("X2");
  const sidY = await session(Y);
  const pY = await prepare(sidY, Y.pnid);
  await store(sidY, pY.registration_id, "292929");
  const foreignSecret = (await su("insert into vault.secrets (name, secret) values ('wa_token_manual_antigo2','NAO-APAGAR-2') returning id")).rows[0].id;
  await su("update whatsapp_number_registrations set pin_secret_id=$1 where id=$2", [foreignSecret, pY.registration_id]);
  await su("delete from companies where id=$1", [Y.c]);
  ck("8.6b apagar o registro nunca apaga segredo fora do prefixo wa_pin_ (trava de nome do gatilho)", (await secretOf(foreignSecret)) === "NAO-APAGAR-2");
  ck("8.6 apagar a empresa apaga o PIN dela no Vault e nenhum outro", (await secretOf(ref)) === null && (await secretOf(other)) !== null);
}

console.log("\n== 9. compatibilidade e isolamento ==");
{
  const Dj = await mkCo("DJ");
  const conn = (await su("insert into company_whatsapp_connections (company_id,status,mode,phone_number_id,waba_id,display_phone_number,token_secret_id,webhook_status) values ($1,'active','test','970000001','100200300','+55 44 90000-0000',gen_random_uuid(),'active') returning *", [Dj.c])).rows[0];
  const before = JSON.stringify((await su("select id,company_id,status,mode,waba_id,phone_number_id,token_secret_id,webhook_status from company_whatsapp_connections where id=$1", [conn.id])).rows[0]);
  await svc("select public.whatsapp_signup_sweep() j");
  await svc("select public.whatsapp_registration_sweep() j");
  ck("9.1 conexão ativa antiga (sem registro de PIN) segue intacta após as limpezas", JSON.stringify((await su("select id,company_id,status,mode,waba_id,phone_number_id,token_secret_id,webhook_status from company_whatsapp_connections where id=$1", [conn.id])).rows[0]) === before);
  ck("9.2 nenhum registro é criado para ela sem uma sessão de signup", Number((await su("select count(*) n from whatsapp_number_registrations where phone_number_id='970000001'")).rows[0].n) === 0);
}
{
  const dig = async () => JSON.stringify((await su("select (select count(*) from whatsapp_conversations) c, (select count(*) from whatsapp_messages) m")).rows[0]);
  const d0 = await dig();
  const Z = await mkCo("Z"); const { aid } = await ready(Z, "202020"); await finish(aid, "success");
  ck("9.3 o fluxo de registro não toca em conversas nem mensagens", (await dig()) === d0);
}
ck("9.4 usuário de uma empresa não enxerga registros/tentativas/tickets (sem grant, RLS)", !(await A.owner("select * from whatsapp_number_registrations")).ok && !(await A.owner("select * from whatsapp_registration_attempts")).ok && !(await A.owner("select * from whatsapp_pin_reveal_requests")).ok);
ck("9.5 CHECKs: estado inválido, par PIN/fonte inconsistente, registered sem data, blocked sem prazo", [
  "update whatsapp_number_registrations set state='x'", "update whatsapp_number_registrations set pin_source='generated', pin_secret_id=null",
  "update whatsapp_number_registrations set state='registered', registered_at=null", "update whatsapp_number_registrations set state='blocked', blocked_until=null",
].every(() => true) && (await Promise.all(["state='x'", "pin_source='generated', pin_secret_id=null", "state='registered', registered_at=null", "state='blocked', blocked_until=null"].map((set) => su(`update whatsapp_number_registrations set ${set} where id='${rid}'`)))).every((r) => !r.ok && r.code === "23514"));
console.log("\n== 10. rollback seguro ==");
{
  const connsBefore = JSON.stringify((await su("select id, company_id, status, mode, waba_id, phone_number_id, token_secret_id from company_whatsapp_connections order by id")).rows);
  const sessBefore = Number((await su("select count(*) n from whatsapp_signup_sessions")).rows[0].n);
  const pinSecretsBefore = Number((await su("select count(*) n from vault.secrets where starts_with(name,'wa_pin_')")).rows[0].n);
  const tokSecretsBefore = Number((await su("select count(*) n from vault.secrets where not starts_with(name,'wa_pin_')")).rows[0].n);
  const fs2 = (await import("node:fs")).default;
  await pg.exec(fs2.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-token-health.rollback.sql", "utf8")); // desfaz 1108 (a tabela de resoluções depende dos registros)
  await pg.exec(fs2.readFileSync("D:/orça facil/.claude/db-tests/whatsapp-registration-pin.rollback.sql", "utf8"));
  ck("10.1 rollback preserva conexões, sessões e todos os segredos do Vault (tokens e PINs)", JSON.stringify((await su("select id, company_id, status, mode, waba_id, phone_number_id, token_secret_id from company_whatsapp_connections order by id")).rows) === connsBefore
    && Number((await su("select count(*) n from whatsapp_signup_sessions")).rows[0].n) === sessBefore && Number((await su("select count(*) n from vault.secrets where starts_with(name,'wa_pin_')")).rows[0].n) === pinSecretsBefore
    && Number((await su("select count(*) n from vault.secrets where not starts_with(name,'wa_pin_')")).rows[0].n) === tokSecretsBefore);
  ck("10.2 objetos da etapa 3 removidos e whatsapp_signup_sweep volta ao comportamento da 1105 (sem pins_removed)", (await su("select to_regclass('public.whatsapp_number_registrations') a, to_regclass('public.whatsapp_pin_reveal_requests') b, to_regprocedure('public.whatsapp_pin_reveal_consume(uuid,uuid)') c")).rows.every((r) => !r.a && !r.b && !r.c)
    && !("pins_removed" in (await svc("select public.whatsapp_signup_sweep() j")).rows[0].j));
}
summary("WHATSAPP REGISTRATION PIN");
