import { toCents } from "./cashLogic";
import { MAX_PART_LABEL, MAX_SPLIT_PARTS, MIN_SPLIT_PARTS, type SplitMode } from "./partialPaymentsLogic";
import { formatCents } from "../../lib/money";

// E9.5 — Regras PURAS do editor de divisão da conta. O SERVIDOR (replace_session_split) é a autoridade: a divisão cobre sempre o SALDO
// PENDENTE, a versão é otimista, os pagamentos e alocações já feitos nunca são tocados e a divisão antiga fica no histórico. Aqui só se
// interpreta o histórico, se pré-visualiza e se valida o óbvio antes de enviar (o banco revalida tudo).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ---------------------------------------------------------------------------------------------- histórico (get_session_split_history)
export interface HistoryPart { partId: string; position: number; label: string; plannedCents: number; paidCents: number; pendingCents: number; status: "pending" | "partial" | "paid"; items: { itemId: string; quantity: number }[] }
export interface HistorySplit { splitId: string; mode: SplitMode; version: number; status: "active" | "superseded"; createdAt: string; supersededAt: string | null; plannedTotalCents: number; paidTotalCents: number; parts: HistoryPart[] }
export interface SplitHistory { sessionStatus: string; activeVersion: number | null; splits: HistorySplit[] }

export function parseSplitHistory(raw: unknown): SplitHistory | null {
  if (!isObj(raw) || !Array.isArray(raw.splits)) return null;
  const splits: HistorySplit[] = [];
  for (const s of raw.splits) {
    if (!isObj(s)) return null;
    const splitId = str(s.split_id), mode = str(s.mode), version = num(s.version), status = str(s.status), created = str(s.created_at);
    const planned = num(s.planned_total), paid = num(s.paid_total);
    if (!splitId || (mode !== "equal" && mode !== "values" && mode !== "products") || version === null || (status !== "active" && status !== "superseded") || !created || planned === null || paid === null || !Array.isArray(s.parts)) return null;
    const parts: HistoryPart[] = [];
    for (const p of s.parts) {
      if (!isObj(p)) return null;
      const partId = str(p.part_id), position = num(p.position), label = str(p.label), pl = num(p.planned), pd = num(p.paid), pe = num(p.pending), st = str(p.status);
      if (!partId || position === null || label === null || pl === null || pd === null || pe === null || (st !== "pending" && st !== "partial" && st !== "paid")) return null;
      const items = Array.isArray(p.items) ? p.items.filter(isObj).map((i) => ({ itemId: String(i.item_id), quantity: num(i.quantity) ?? 0 })) : [];
      parts.push({ partId, position, label, plannedCents: toCents(pl), paidCents: toCents(pd), pendingCents: toCents(pe), status: st, items });
    }
    splits.push({ splitId, mode, version, status, createdAt: created, supersededAt: str(s.superseded_at), plannedTotalCents: toCents(planned), paidTotalCents: toCents(paid), parts: parts.sort((a, b) => a.position - b.position) });
  }
  return { sessionStatus: str(raw.session_status) ?? "", activeVersion: num(raw.active_version), splits: splits.sort((a, b) => a.version - b.version) };
}
// Versão que a tela está vendo (0 = ainda não há divisão): é a que se envia como p_expected_version.
export const currentVersion = (h: SplitHistory | null | undefined): number => (h?.activeVersion ?? 0);
export const activeSplit = (h: SplitHistory | null | undefined): HistorySplit | null => h?.splits.find((s) => s.status === "active") ?? null;

// ---------------------------------------------------------------------------------------------- por pessoas iguais (pré-visualização)
// Mesma regra do servidor (S-5): saldo ÷ n por piso; os centavos que sobram vão +1 para as PRIMEIRAS partes. null = impossível.
export function equalPreview(balanceCents: number, n: number): number[] | null {
  if (!Number.isInteger(balanceCents) || !Number.isInteger(n) || n < MIN_SPLIT_PARTS || n > MAX_SPLIT_PARTS || balanceCents < n) return null;
  const base = Math.floor(balanceCents / n), extra = balanceCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------- por valores
export const valuesRemaining = (balanceCents: number, amounts: readonly number[]): number => balanceCents - amounts.reduce((s, a) => s + a, 0);

// ---------------------------------------------------------------------------------------------- por produtos
export interface OrderItemSource { itemId: string; name: string; unitCents: number; billable: number }   // itens cobráveis da conta (quantidade - cancelada)
export interface PoolItem extends OrderItemSource { locked: number; available: number }
// Unidades TRAVADAS = as de partes já QUITADAS em qualquer versão (mesma regra do servidor, S-8): ninguém paga o mesmo item duas vezes.
export function buildPool(items: readonly OrderItemSource[], history: SplitHistory | null | undefined): PoolItem[] {
  const locked = new Map<string, number>();
  for (const s of history?.splits ?? []) for (const p of s.parts) if (p.status === "paid") for (const it of p.items) locked.set(it.itemId, (locked.get(it.itemId) ?? 0) + it.quantity);
  return items.filter((i) => i.billable > 0).map((i) => { const l = locked.get(i.itemId) ?? 0; return { ...i, locked: l, available: Math.max(i.billable - l, 0) }; });
}
export const poolValueCents = (pool: readonly PoolItem[]): number => pool.reduce((s, i) => s + i.available * i.unitCents, 0);
// S-9: por produtos só quando o dinheiro já pago corresponde a itens quitados (o valor das unidades disponíveis é IGUAL ao saldo).
export function productsModeProblem(pool: readonly PoolItem[], balanceCents: number): string | null {
  if (pool.every((i) => i.available === 0)) return "Não há itens disponíveis para dividir por produto.";
  if (poolValueCents(pool) !== balanceCents) return "Por produtos não está disponível: há valor já pago que não corresponde a itens quitados. Divida o saldo em partes iguais ou por valores.";
  return null;
}
export type Assignment = { label: string; qty: Record<string, number> };
export const partCents = (pool: readonly PoolItem[], qty: Record<string, number>): number => pool.reduce((s, i) => s + (qty[i.itemId] ?? 0) * i.unitCents, 0);
export function unassignedUnits(pool: readonly PoolItem[], parts: readonly Assignment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of pool) out[i.itemId] = i.available - parts.reduce((s, p) => s + (p.qty[i.itemId] ?? 0), 0);
  return out;
}
export function validateProducts(pool: readonly PoolItem[], parts: readonly Assignment[], balanceCents: number): string | null {
  const mode = productsModeProblem(pool, balanceCents);
  if (mode) return mode;
  if (parts.length < MIN_SPLIT_PARTS || parts.length > MAX_SPLIT_PARTS) return "Uma divisão precisa de 2 a 50 partes.";
  for (const p of parts) for (const [id, q] of Object.entries(p.qty)) if (!Number.isInteger(q) || q < 0 || !pool.some((i) => i.itemId === id)) return "Quantidade inválida em uma das partes.";
  if (parts.some((p) => partCents(pool, p.qty) <= 0)) return "Cada parte precisa ter pelo menos um item.";
  const left = unassignedUnits(pool, parts);
  for (const i of pool) {
    if (left[i.itemId] < 0) return `O item "${i.name}" foi atribuído a mais de uma pessoa (disponível: ${i.available}).`;
    if (left[i.itemId] > 0) return `Há unidades de "${i.name}" sem pessoa responsável; atribua todas as unidades.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- rótulos
export function labelProblem(labels: readonly string[]): string | null {
  const l = labels.map((x) => x.trim()).filter((x) => x !== "");
  if (l.some((x) => x.length > MAX_PART_LABEL)) return "O nome da parte pode ter no máximo 40 caracteres.";
  if (new Set(l.map((x) => x.toLocaleLowerCase("pt-BR"))).size !== l.length) return "Dois nomes de parte estão repetidos.";
  return null;
}

// ---------------------------------------------------------------------------------------------- impacto de refazer (sem redistribuição silenciosa)
export interface ReplaceImpact { hasActive: boolean; version: number; paidPreservedCents: number; partsPaid: number; partsPartial: number; needsConfirm: boolean; lines: string[] }
export function replaceImpact(history: SplitHistory | null | undefined, balanceCents: number): ReplaceImpact {
  const a = activeSplit(history);
  if (!a) return { hasActive: false, version: 0, paidPreservedCents: 0, partsPaid: 0, partsPartial: 0, needsConfirm: false, lines: [`A divisão cobrirá o saldo de ${formatCents(balanceCents)}.`] };
  const paidParts = a.parts.filter((p) => p.status === "paid").length, partial = a.parts.filter((p) => p.status === "partial").length;
  const lines = [`A versão ${a.version} fica guardada no histórico; nada do que já foi pago é alterado nem redistribuído.`, `A nova divisão cobrirá SÓ o saldo pendente: ${formatCents(balanceCents)}.`];
  if (paidParts > 0) lines.push(paidParts === 1 ? `1 parte já quitada permanece na versão ${a.version} e não entra na nova divisão.` : `${paidParts} partes já quitadas permanecem na versão ${a.version} e não entram na nova divisão.`);
  if (partial > 0) lines.push(`${partial} ${partial === 1 ? "parte parcialmente paga volta" : "partes parcialmente pagas voltam"} pelo que falta pagar.`);
  return { hasActive: true, version: a.version, paidPreservedCents: a.paidTotalCents, partsPaid: paidParts, partsPartial: partial, needsConfirm: a.paidTotalCents > 0, lines };
}

// Por pessoa (rótulo) ao longo das versões: quanto já pagou e quanto falta (a pessoa só tem identidade pelo rótulo).
export function personTotals(history: SplitHistory | null | undefined): { label: string; paidCents: number; pendingCents: number }[] {
  const m = new Map<string, { label: string; paidCents: number; pendingCents: number }>();
  for (const s of history?.splits ?? []) for (const p of s.parts) {
    const key = p.label.trim().toLocaleLowerCase("pt-BR");
    const cur = m.get(key) ?? { label: p.label, paidCents: 0, pendingCents: 0 };
    cur.paidCents += p.paidCents;
    if (s.status === "active") cur.pendingCents += p.pendingCents;
    m.set(key, cur);
  }
  return [...m.values()];
}

export const MODE_LABEL: Record<SplitMode, string> = { equal: "Partes iguais", values: "Por valores", products: "Por produtos" };
