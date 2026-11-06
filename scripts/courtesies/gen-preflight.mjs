// Gera o PRÉ-FLIGHT DE DERIVA das migrations de cortesias (20261115 a 20261120).
//   node scripts/courtesies/gen-preflight.mjs           -> escreve supabase/preflight/courtesies/{manifest.json,courtesy-preflight.sql}
//   node scripts/courtesies/gen-preflight.mjs --check   -> falha (exit 1) se os arquivos versionados estão desatualizados em relação às migrations
// Só usa banco descartável (PGlite). O SQL gerado é SOMENTE LEITURA (um único SELECT em catálogos) e não contém barra invertida
// (a CLI do Supabase a consome). Ele compara, no banco ALVO, as funções/tabelas que as migrations substituem, aplicam por "patch" de texto
// ou dependem, com o que cada ETAPA (0 = antes de 1115 … 6 = depois de 1120) deve ter, e devolve um veredito em JSON.
import fs from "node:fs";
import path from "node:path";
import { COURTESY, MIG, PREFLIGHT_DIR, FN_HASH, FN_KEY, TABLE_SIG, loadAllFn, stageDir, fnHashes } from "./lib.mjs";

const loadAll = await loadAllFn();
const ABSENT = "ABSENT";

// Tabelas citadas pelas 6 migrations (para checar dependências por assinatura de colunas).
const text = COURTESY.map((f) => fs.readFileSync(path.join(MIG, f), "utf8")).join("\n");
const mentioned = new Set([...text.matchAll(/public\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));

async function tableHashes(pg) {
  const r = await pg.query(`select split_part(k, '.', 1) t, md5(string_agg(k, ',' order by k)) h from (${TABLE_SIG}) x group by 1`);
  return Object.fromEntries(r.rows.map((x) => [x.t, x.h]));
}

const stages = [];
for (let k = 0; k <= COURTESY.length; k++) {
  const { pg } = await loadAll(stageDir(k), { legacyIaMirror: false });
  stages.push({ fns: await fnHashes(pg), tabs: await tableHashes(pg) });
}
const s0 = stages[0];

// Funções rastreadas: as que NÃO existem antes das cortesias (criadas/renomeadas) e as pré-existentes que mudam em alguma etapa.
const trackedFns = new Set();
for (const s of stages) for (const [k, h] of Object.entries(s.fns)) if (!(k in s0.fns) || stages.some((x) => x.fns[k] !== s0.fns[k])) trackedFns.add(k);
for (const k of Object.keys(s0.fns)) if (stages.some((x) => x.fns[k] !== s0.fns[k])) trackedFns.add(k);
// Tabelas rastreadas: as citadas que já existiam (dependências) + as criadas pelas cortesias.
const trackedTabs = new Set([...Object.keys(s0.tabs).filter((t) => mentioned.has(t)), ...stages.flatMap((s) => Object.keys(s.tabs)).filter((t) => !(t in s0.tabs))]);

const manifest = {
  version: 1,
  migrations: COURTESY.map((f) => f.slice(0, 14)),
  // migrations anteriores às cortesias que o repositório contém (têm de estar aplicadas no alvo)
  prerequisite_versions: fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f < "20261115010000").map((f) => f.slice(0, 14)).sort(),
  stages: Object.fromEntries(stages.map((s, k) => [k, {
    fns: Object.fromEntries([...trackedFns].sort().map((f) => [f, s.fns[f] ?? ABSENT])),
    tabs: Object.fromEntries([...trackedTabs].sort().map((t) => [t, s.tabs[t] ?? ABSENT])),
  }])),
};
// compacta: as funções cujo hash não muda em nenhuma etapa (dependências estáveis) continuam, pois a deriva delas também importa
const json = JSON.stringify(manifest, null, 1).replace(/\r/g, "");
if (json.includes("'") || json.includes("\\")) throw new Error("manifesto com aspas/barras — ajustar o gerador");

const sql = `-- PRÉ-FLIGHT DE DERIVA — cortesias (migrations 20261115 a 20261120). SOMENTE LEITURA: um único SELECT em catálogos.
-- GERADO por scripts/courtesies/gen-preflight.mjs (não editar à mão; rode com --check para saber se está desatualizado).
-- Uso (banco de homologação OU remoto, somente leitura):
--   node node_modules/supabase/dist/supabase.js db query --linked -f supabase/preflight/courtesies/courtesy-preflight.sql -o json
-- Resultado: UMA linha com { verdict, safe_to_apply, observed_stage, next_migration, mismatches, history, ... }.
--   verdict = ready    -> nada de cortesia aplicado e tudo que as migrations substituem está idêntico ao esperado: pode aplicar 1115..1120
--   verdict = partial  -> aplicado até a etapa observed_stage; pode aplicar as restantes (next_migration em diante)
--   verdict = applied  -> as seis já estão aplicadas e as definições são as esperadas
--   verdict = drift    -> NÃO aplicar: veja mismatches (função/tabela, esperado x observado) e history
-- Etapa k = estado depois da k-ésima migration (0 = antes de 1115). Hash = md5 do corpo normalizado + segurança + config + volatilidade + retorno.
with m as (select '${json.replace(/\n\s*/g, "")}'::jsonb as j),
stages as (select s.key::int as k, s.value as d from m, jsonb_each(m.j -> 'stages') s),
tf as (select st.k, f.key as fkey, f.value #>> '{}' as h from stages st, jsonb_each(st.d -> 'fns') f),
tt as (select st.k, t.key as tkey, t.value #>> '{}' as h from stages st, jsonb_each(st.d -> 'tabs') t),
obs_fn as (
  select ${FN_KEY} as fkey, ${FN_HASH} as h
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
),
obs_tab as (
  select split_part(k, '.', 1) as tkey, md5(string_agg(k, ',' order by k)) as h from (${TABLE_SIG}) x group by 1
),
mis as (
  select tf.k, 'function' as kind, tf.fkey as name, tf.h as expected, coalesce(o.h, '${ABSENT}') as observed
    from tf left join obs_fn o on o.fkey = tf.fkey where tf.h is distinct from coalesce(o.h, '${ABSENT}')
  union all
  select tt.k, 'table', tt.tkey, tt.h, coalesce(o.h, '${ABSENT}')
    from tt left join obs_tab o on o.tkey = tt.tkey where tt.h is distinct from coalesce(o.h, '${ABSENT}')
),
per_stage as (select st.k, count(mis.k)::int as n from stages st left join mis on mis.k = st.k group by st.k),
pick as (
  select coalesce((select min(k) from per_stage where n = 0), -1) as matched,
         (select k from per_stage order by n, k limit 1) as best
),
hist as (
  select case when to_regclass('supabase_migrations.schema_migrations') is null then null
         else (select coalesce(array_agg((xpath('/row/version/text()', r))[1]::text order by (xpath('/row/version/text()', r))[1]::text), '{}')
                 from unnest(xpath('/table/row', query_to_xml('select version from supabase_migrations.schema_migrations', false, false, ''))) r) end as versions
),
hx as (
  select h.versions,
         (select array_agg(v order by v) from jsonb_array_elements_text((select j -> 'migrations' from m)) v where h.versions is not null and v = any (h.versions)) as courtesy_applied,
         (select array_agg(v order by v) from jsonb_array_elements_text((select j -> 'prerequisite_versions' from m)) v where h.versions is not null and not (v = any (h.versions))) as prerequisites_missing,
         (select array_agg(v order by v) from unnest(coalesce(h.versions, '{}')) v
           where v > '20261114999999' and not (v in (select jsonb_array_elements_text((select j -> 'migrations' from m))))) as newer_unknown
    from hist h
)
select jsonb_pretty(jsonb_build_object(
  'verdict', case when pick.matched = -1 then 'drift'
                  when hx.prerequisites_missing is not null then 'drift'
                  when hx.versions is not null and coalesce(cardinality(hx.courtesy_applied), 0) <> pick.matched then 'drift'
                  when pick.matched = 0 then 'ready'
                  when pick.matched = (select count(*) from stages) - 1 then 'applied'
                  else 'partial' end,
  'safe_to_apply', pick.matched between 0 and (select count(*) from stages) - 2 and hx.prerequisites_missing is null
                   and (hx.versions is null or coalesce(cardinality(hx.courtesy_applied), 0) = pick.matched),
  'observed_stage', case when pick.matched = -1 then null else pick.matched end,
  'closest_stage', pick.best,
  'next_migration', case when pick.matched between 0 and (select count(*) from stages) - 2 then (select j -> 'migrations' ->> pick.matched from m) end,
  'mismatch_count_by_stage', (select jsonb_object_agg(k::text, n order by k) from per_stage),
  'mismatches', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'name', name, 'expected', expected, 'observed', observed) order by kind, name)
                            from mis where mis.k = case when pick.matched = -1 then pick.best else pick.matched end), '[]'::jsonb),
  'history', jsonb_build_object('known', hx.versions is not null,
                                'courtesy_applied', to_jsonb(coalesce(hx.courtesy_applied, '{}')),
                                'prerequisites_missing', to_jsonb(coalesce(hx.prerequisites_missing, '{}')),
                                'newer_unknown', to_jsonb(coalesce(hx.newer_unknown, '{}'))),
  'tracked', jsonb_build_object('functions', (select count(*) from tf where k = 0), 'tables', (select count(*) from tt where k = 0))
)) as preflight
from pick, hx;
`;

const out = { "manifest.json": json + "\n", "courtesy-preflight.sql": sql };
if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [f, c] of Object.entries(out)) {
    const cur = fs.existsSync(path.join(PREFLIGHT_DIR, f)) ? fs.readFileSync(path.join(PREFLIGHT_DIR, f), "utf8").replace(/\r\n/g, "\n") : null;
    if (cur !== c) { console.log(`DESATUALIZADO ${f}`); bad++; } else console.log(`ok ${f}`);
  }
  process.exit(bad ? 1 : 0);
}
fs.mkdirSync(PREFLIGHT_DIR, { recursive: true });
for (const [f, c] of Object.entries(out)) fs.writeFileSync(path.join(PREFLIGHT_DIR, f), c);
console.log(`gerado: ${trackedFns.size} funções e ${trackedTabs.size} tabelas rastreadas em ${stages.length} etapas -> ${PREFLIGHT_DIR}`);
