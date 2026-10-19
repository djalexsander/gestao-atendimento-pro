// Conhecimento da empresa (Etapa 1): lógica pura do perfil comercial — horários, formas de pagamento, validação e resumos somente leitura.
// O formato dos horários é o MESMO de company_whatsapp_ai_settings.business_schedule: { timezone, days: { mon..sun: [["HH:MM","HH:MM"], ...] } }.

export const WEEK_DAYS = [
  { key: "mon", label: "Segunda-feira" },
  { key: "tue", label: "Terça-feira" },
  { key: "wed", label: "Quarta-feira" },
  { key: "thu", label: "Quinta-feira" },
  { key: "fri", label: "Sexta-feira" },
  { key: "sat", label: "Sábado" },
  { key: "sun", label: "Domingo" },
] as const;
export type DayKey = (typeof WEEK_DAYS)[number]["key"];

export const PAYMENT_OPTIONS = [
  { code: "cash", label: "Dinheiro" },
  { code: "pix", label: "Pix" },
  { code: "debit_card", label: "Cartão de débito" },
  { code: "credit_card", label: "Cartão de crédito" },
  { code: "other", label: "Outro" },
] as const;
export type PaymentCode = (typeof PAYMENT_OPTIONS)[number]["code"];

export const TIMEZONE_OPTIONS = [
  { value: "America/Sao_Paulo", label: "Brasília (UTC−3)" },
  { value: "America/Manaus", label: "Manaus (UTC−4)" },
  { value: "America/Cuiaba", label: "Cuiabá (UTC−4)" },
  { value: "America/Rio_Branco", label: "Rio Branco (UTC−5)" },
  { value: "America/Noronha", label: "Fernando de Noronha (UTC−2)" },
] as const;

export const AVAILABILITY_OPTIONS = [
  { value: "catalog", label: "Catálogo", hint: "A IA pode informar que o produto faz parte do cardápio, sem garantir disponibilidade em tempo real." },
  { value: "live", label: "Disponibilidade em tempo real", hint: "A IA poderá considerar disponibilidade de venda e estoque, sem informar quantidades." },
] as const;
export type AvailabilityMode = "catalog" | "live";

export const NOTES_MAX = 1000;
export const ADDRESS_MAX = 300;
export const PIX_MAX = 300;

export type Period = { start: string; end: string };
export type HoursDraft = Record<DayKey, { closed: boolean; periods: Period[] }>;

export interface BusinessProfile {
  configured: boolean;
  addressText: string;
  timezone: string;
  weeklyHours: unknown;
  closedDates: { date: string; label: string }[];
  paymentMethods: PaymentCode[];
  pixInstructions: string;
  publicNotes: string;
  knowledgeEnabled: boolean;
  aiAvailabilityMode: AvailabilityMode;
  summary: KnowledgeSummary;
}

export interface KnowledgeSummary {
  catalog: { productsActive: number; categoriesActive: number };
  contact: { name: string; phone: string; whatsapp: string; email: string };
  delivery: { configured: boolean; deliveryEnabled: boolean; pickupEnabled: boolean; deliveryMinutes: number | null; pickupMinutes: number | null; defaultFee: number | null; zonesActive: number };
}

export interface BusinessProfileInput {
  addressText: string;
  timezone: string;
  weeklyHours: unknown;
  closedDates: { date: string; label: string }[];
  paymentMethods: PaymentCode[];
  pixInstructions: string;
  publicNotes: string;
  aiAvailabilityMode: AvailabilityMode;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = WEEK_DAYS.map((d) => d.key) as DayKey[];
const PAY_CODES = PAYMENT_OPTIONS.map((p) => p.code) as PaymentCode[];

export function emptyHours(): HoursDraft {
  const h = {} as HoursDraft;
  for (const k of DAY_KEYS) h[k] = { closed: true, periods: [] };
  return h;
}

/** JSON do banco -> rascunho editável. Dia ausente ou vazio = fechado. */
export function hoursToDraft(json: unknown): HoursDraft {
  const draft = emptyHours();
  const days = (json as { days?: Record<string, unknown> } | null)?.days;
  if (!days || typeof days !== "object") return draft;
  for (const k of DAY_KEYS) {
    const raw = (days as Record<string, unknown>)[k];
    if (!Array.isArray(raw)) continue;
    const periods = raw
      .filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string")
      .map((p) => ({ start: p[0], end: p[1] }));
    if (periods.length) draft[k] = { closed: false, periods };
  }
  return draft;
}

/** Rascunho -> JSON do banco (mon..sun). Dias fechados ficam de fora; nenhum dia aberto => days vazio (o banco guarda "não informado"). */
export function draftToHours(draft: HoursDraft, timezone: string): { timezone: string; days: Record<string, string[][]> } {
  const days: Record<string, string[][]> = {};
  for (const k of DAY_KEYS) {
    const d = draft[k];
    if (!d || d.closed || d.periods.length === 0) continue;
    days[k] = d.periods.map((p) => [p.start, p.end]);
  }
  return { timezone, days };
}

/** Valida o rascunho: HH:MM, início antes do fim, no máximo 4 períodos e sem sobreposição (encostar pode). Retorna a mensagem ou null. */
export function hoursError(draft: HoursDraft): string | null {
  for (const d of WEEK_DAYS) {
    const day = draft[d.key];
    if (!day || day.closed) continue;
    if (day.periods.length === 0) return `${d.label}: adicione um período ou marque como fechado.`;
    if (day.periods.length > 4) return `${d.label}: no máximo 4 períodos por dia.`;
    for (const p of day.periods) {
      if (!TIME_RE.test(p.start) || !TIME_RE.test(p.end)) return `${d.label}: use horários no formato HH:MM.`;
      if (p.start >= p.end) return `${d.label}: o início precisa ser antes do fim.`;
    }
    const sorted = [...day.periods].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) return `${d.label}: os períodos não podem se sobrepor.`;
    }
  }
  return null;
}

export function paymentLabel(code: string): string {
  return PAYMENT_OPTIONS.find((p) => p.code === code)?.label ?? code;
}

export function togglePayment(current: PaymentCode[], code: PaymentCode, on: boolean): PaymentCode[] {
  const set = new Set(current);
  if (on) set.add(code);
  else set.delete(code);
  return PAY_CODES.filter((c) => set.has(c));
}

export function profileError(i: BusinessProfileInput, hours: HoursDraft): string | null {
  if (i.addressText.trim().length > ADDRESS_MAX) return `O endereço pode ter no máximo ${ADDRESS_MAX} caracteres.`;
  if (i.pixInstructions.trim().length > PIX_MAX) return `O texto do Pix pode ter no máximo ${PIX_MAX} caracteres.`;
  if (i.publicNotes.trim().length > NOTES_MAX) return `As observações podem ter no máximo ${NOTES_MAX} caracteres.`;
  const h = hoursError(hours);
  if (h) return h;
  const seen = new Set<string>();
  for (const c of i.closedDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return "Informe as datas fechadas completas.";
    if (seen.has(c.date)) return "Há datas fechadas repetidas.";
    seen.add(c.date);
    if (c.label.length > 60) return "O nome da data fechada pode ter no máximo 60 caracteres.";
  }
  return null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Resposta da RPC whatsapp_ai_get_business_profile -> modelo da tela. Tolerante a campos ausentes. */
export function toBusinessProfile(raw: unknown): BusinessProfile {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (r.summary ?? {}) as Record<string, Record<string, unknown>>;
  const cat = s.catalog ?? {};
  const con = s.contact ?? {};
  const del = s.delivery ?? {};
  const methods = Array.isArray(r.payment_methods) ? (r.payment_methods as string[]).filter((c): c is PaymentCode => (PAY_CODES as string[]).includes(c)) : [];
  const closed = Array.isArray(r.closed_dates)
    ? (r.closed_dates as { date?: unknown; label?: unknown }[]).filter((c) => typeof c?.date === "string").map((c) => ({ date: String(c.date), label: str(c.label) }))
    : [];
  return {
    configured: r.configured === true,
    addressText: str(r.address_text),
    timezone: str(r.timezone) || "America/Sao_Paulo",
    weeklyHours: r.weekly_hours ?? null,
    closedDates: closed,
    paymentMethods: methods,
    pixInstructions: str(r.pix_instructions),
    publicNotes: str(r.public_notes),
    knowledgeEnabled: r.knowledge_enabled === true,
    aiAvailabilityMode: r.ai_availability_mode === "live" ? "live" : "catalog",
    summary: {
      catalog: { productsActive: num(cat.products_active) ?? 0, categoriesActive: num(cat.categories_active) ?? 0 },
      contact: { name: str(con.name), phone: str(con.phone), whatsapp: str(con.whatsapp), email: str(con.email) },
      delivery: {
        configured: del.configured === true,
        deliveryEnabled: del.delivery_enabled === true,
        pickupEnabled: del.pickup_enabled === true,
        deliveryMinutes: num(del.delivery_minutes),
        pickupMinutes: num(del.pickup_minutes),
        defaultFee: num(del.default_fee),
        zonesActive: num(del.zones_active) ?? 0,
      },
    },
  };
}

export function formatFee(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function deliverySummaryText(d: KnowledgeSummary["delivery"]): string[] {
  if (!d.configured) return ["Entrega ainda não configurada."];
  const lines = [
    `Entrega: ${d.deliveryEnabled ? "ativada" : "desativada"}${d.deliveryEnabled && d.deliveryMinutes !== null ? ` (cerca de ${d.deliveryMinutes} min)` : ""}`,
    `Retirada: ${d.pickupEnabled ? "ativada" : "desativada"}${d.pickupEnabled && d.pickupMinutes !== null ? ` (cerca de ${d.pickupMinutes} min)` : ""}`,
    `Taxa padrão: ${formatFee(d.defaultFee)}`,
    `Zonas de entrega ativas: ${d.zonesActive}`,
  ];
  return lines;
}

export function toProfileInput(
  base: { addressText: string; timezone: string; closedDates: { date: string; label: string }[]; paymentMethods: PaymentCode[]; pixInstructions: string; publicNotes: string; aiAvailabilityMode: AvailabilityMode },
  hours: HoursDraft,
): BusinessProfileInput {
  return { ...base, weeklyHours: draftToHours(hours, base.timezone) };
}
