import { supabase } from "../../lib/supabaseClient";
import type { RealtimeClientLike } from "../../lib/productsRealtime";
import { OPEN_ATTENDANCE_TABLES, subscribeToOpenAttendanceChanges } from "../operations/openSessionsRealtime";
import { describeOrderError } from "../orders/ordersLogic";
import {
  toAddress,
  toDeliveryRow,
  toQuote,
  toSettings,
  toZone,
  type AddressForm,
  type AddressRow,
  type CreateArgs,
  type DeliveryFilters,
  type DeliveryQuote,
  type DeliveryRow,
  type DeliverySettings,
  type Fulfillment,
  type LogisticStatus,
  type RawAddress,
  type RawDeliveryRow,
  type RawQuote,
  type RawSettings,
  type RawZone,
  type ZoneRow,
  periodDates,
} from "./deliveryLogic";

export type Result<T> = { data: T; error: null } | { data: null; error: string };

export interface CourierOption {
  userId: string;
  name: string;
}
export interface DeliveryEvent {
  eventType: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  note: string | null;
  createdAt: string;
}
export interface DeliveryDetailItem {
  id: string;
  name: string;
  quantity: number;
  cancelledQuantity: number;
  unitPrice: number | null; // null para o entregador (sem preços)
  productionStatus: "pending" | "preparing" | "ready";
  notes: string | null;
  modifiers: Array<{ name: string; type: "add" | "remove"; priceDelta: number | null }>;
}
export interface DeliveryDetail {
  items: DeliveryDetailItem[];
  events: DeliveryEvent[];
}
export interface CreatedDelivery {
  deliveryOrderId: string;
  replayed: boolean;
  total: number;
  deliveryFee: number;
}

// Fonte de dados do Delivery: recebida por parâmetro para exercitar as telas com dados simulados. Toda regra
// (taxa, previsão, estado, papel, módulo, total) é do servidor.
export interface DeliverySource {
  list(companyId: string, filters: DeliveryFilters): Promise<Result<DeliveryRow[]>>;
  get(deliveryOrderId: string): Promise<Result<DeliveryDetail>>;
  create(args: CreateArgs): Promise<Result<CreatedDelivery>>;
  setStatus(deliveryOrderId: string, status: "out_for_delivery" | "delivered" | "picked_up"): Promise<Result<null>>;
  cancel(deliveryOrderId: string, reason: string): Promise<Result<null>>;
  assignCourier(deliveryOrderId: string, courierUserId: string | null): Promise<Result<null>>;
  couriers(companyId: string): Promise<Result<CourierOption[]>>;
  quote(companyId: string, fulfillment: Fulfillment, city: string | null, neighborhood: string | null): Promise<Result<DeliveryQuote>>;
  addresses(customerId: string, includeInactive?: boolean): Promise<Result<AddressRow[]>>;
  createAddress(customerId: string, form: AddressForm): Promise<Result<AddressRow>>;
  updateAddress(addressId: string, form: AddressForm): Promise<Result<AddressRow>>;
  setAddressActive(addressId: string, active: boolean): Promise<Result<null>>;
  settings(companyId: string): Promise<Result<DeliverySettings>>;
  updateSettings(companyId: string, s: DeliverySettings): Promise<Result<DeliverySettings>>;
  zones(companyId: string): Promise<Result<ZoneRow[]>>;
  saveZone(companyId: string, zoneId: string | null, v: { name: string; neighborhood: string; city: string; fee: number; minutes: number | null }): Promise<Result<ZoneRow>>;
  setZoneActive(zoneId: string, active: boolean): Promise<Result<null>>;
  subscribe(companyId: string, onChange: () => void): () => void;
}

const GENERIC = "Não foi possível concluir a operação agora. Tente novamente.";

function fail<T>(error: { code?: string | null; message?: string | null }, fallback = GENERIC): Result<T> {
  console.error("Falha no Delivery:", error.code ?? "sem código"); // nunca registra dados do cliente
  return { data: null, error: describeOrderError(error, fallback) };
}

const nz = (v: string): string | null => v.trim() || null;
const addressArgs = (f: AddressForm) => ({
  p_street: f.street,
  p_neighborhood: f.neighborhood,
  p_city: f.city,
  p_state: f.state,
  p_number: nz(f.number),
  p_complement: nz(f.complement),
  p_cep: nz(f.cep),
  p_label: nz(f.label),
  p_reference: nz(f.reference),
});

interface RawEvent {
  event_type: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
}
interface RawDetailItem {
  id: string;
  name: string;
  quantity: number;
  cancelled_quantity: number;
  unit_price: number | string | null;
  production_status: "pending" | "preparing" | "ready";
  notes: string | null;
  modifiers: Array<{ name: string; type: "add" | "remove"; price_delta?: number | string | null }> | null;
}

export const supabaseDeliverySource: DeliverySource = {
  async list(companyId, filters) {
    const { from, to } = periodDates(filters.preset, filters.range);
    const { data, error } = await supabase.rpc("list_delivery_orders", {
      p_company_id: companyId,
      p_from: from,
      p_to: to,
      p_fulfillment: filters.fulfillment === "all" ? null : filters.fulfillment,
      p_status: filters.status === "all" ? null : (filters.status as LogisticStatus),
      p_courier_user_id: filters.courierUserId === "all" || filters.courierUserId === "none" ? null : filters.courierUserId,
      p_customer_id: null,
      p_limit: 200,
      p_offset: 0,
    });
    if (error) return fail(error, "Não foi possível carregar os pedidos agora. Tente novamente.");
    return { data: ((data ?? []) as RawDeliveryRow[]).map(toDeliveryRow), error: null };
  },

  async get(deliveryOrderId) {
    const { data, error } = await supabase.rpc("get_delivery_order", { p_delivery_order_id: deliveryOrderId });
    if (error) return fail(error, "Não foi possível carregar o pedido agora.");
    const j = data as { items: RawDetailItem[]; events: RawEvent[] };
    return {
      data: {
        items: (j.items ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          cancelledQuantity: i.cancelled_quantity,
          unitPrice: i.unit_price === null ? null : Number(i.unit_price),
          productionStatus: i.production_status,
          notes: i.notes,
          modifiers: (i.modifiers ?? []).map((m) => ({
            name: m.name,
            type: m.type === "remove" ? ("remove" as const) : ("add" as const),
            priceDelta: m.price_delta === undefined || m.price_delta === null ? null : Number(m.price_delta),
          })),
        })),
        events: (j.events ?? []).map((e) => ({ eventType: e.event_type, oldValue: e.old_value, newValue: e.new_value, note: e.note, createdAt: e.created_at })),
      },
      error: null,
    };
  },

  async create(args) {
    const { data, error } = await supabase.rpc("create_delivery_order", args);
    if (error) return fail(error, "Não foi possível criar o pedido agora. Tente novamente.");
    const j = data as { delivery_order_id: string; replayed: boolean; total: number | string; delivery_fee: number | string };
    return { data: { deliveryOrderId: j.delivery_order_id, replayed: j.replayed, total: Number(j.total), deliveryFee: Number(j.delivery_fee) }, error: null };
  },

  async setStatus(deliveryOrderId, status) {
    const { error } = await supabase.rpc("set_delivery_status", { p_delivery_order_id: deliveryOrderId, p_status: status, p_note: null });
    return error ? fail(error) : { data: null, error: null };
  },

  async cancel(deliveryOrderId, reason) {
    const { error } = await supabase.rpc("cancel_delivery_order", { p_delivery_order_id: deliveryOrderId, p_reason: reason });
    return error ? fail(error, "Não foi possível cancelar o pedido agora.") : { data: null, error: null };
  },

  async assignCourier(deliveryOrderId, courierUserId) {
    const { error } = await supabase.rpc("assign_delivery_courier", { p_delivery_order_id: deliveryOrderId, p_courier_user_id: courierUserId });
    return error ? fail(error) : { data: null, error: null };
  },

  async couriers(companyId) {
    const { data, error } = await supabase.rpc("list_delivery_couriers", { p_company_id: companyId });
    if (error) return fail(error);
    return { data: ((data ?? []) as Array<{ user_id: string; name: string }>).map((c) => ({ userId: c.user_id, name: c.name })), error: null };
  },

  async quote(companyId, fulfillment, city, neighborhood) {
    const { data, error } = await supabase.rpc("resolve_delivery_quote", {
      p_company_id: companyId,
      p_fulfillment: fulfillment,
      p_city: city,
      p_neighborhood: neighborhood,
    });
    if (error) return fail(error, "Não foi possível calcular a taxa agora.");
    return { data: toQuote(data as RawQuote), error: null };
  },

  async addresses(customerId, includeInactive = false) {
    const { data, error } = await supabase.rpc("list_customer_addresses", { p_customer_id: customerId, p_include_inactive: includeInactive });
    if (error) return fail(error, "Não foi possível carregar os endereços agora.");
    return { data: ((data ?? []) as RawAddress[]).map(toAddress), error: null };
  },

  async createAddress(customerId, form) {
    const { data, error } = await supabase.rpc("create_customer_address", { p_customer_id: customerId, ...addressArgs(form) });
    if (error) return fail(error, "Não foi possível salvar o endereço agora.");
    return { data: toAddress(data as RawAddress), error: null };
  },

  async updateAddress(addressId, form) {
    const { data, error } = await supabase.rpc("update_customer_address", { p_address_id: addressId, ...addressArgs(form) });
    if (error) return fail(error, "Não foi possível salvar o endereço agora.");
    return { data: toAddress(data as RawAddress), error: null };
  },

  async setAddressActive(addressId, active) {
    const { error } = await supabase.rpc("set_customer_address_active", { p_address_id: addressId, p_active: active });
    return error ? fail(error) : { data: null, error: null };
  },

  async settings(companyId) {
    const { data, error } = await supabase.rpc("get_delivery_settings", { p_company_id: companyId });
    if (error) return fail(error, "Não foi possível carregar as configurações agora.");
    return { data: toSettings(data as RawSettings), error: null };
  },

  async updateSettings(companyId, s) {
    const { data, error } = await supabase.rpc("update_delivery_settings", {
      p_company_id: companyId,
      p_delivery_enabled: s.deliveryEnabled,
      p_pickup_enabled: s.pickupEnabled,
      p_delivery_minutes: s.deliveryMinutes,
      p_pickup_minutes: s.pickupMinutes,
      p_default_fee: s.defaultFee,
      p_allow_manual_fee: s.allowManualFee,
      p_default_instructions: s.defaultInstructions.trim() || null,
    });
    if (error) return fail(error, "Não foi possível salvar as configurações agora.");
    return { data: toSettings(data as RawSettings), error: null };
  },

  async zones(companyId) {
    const { data, error } = await supabase.rpc("list_delivery_zones", { p_company_id: companyId, p_include_inactive: true });
    if (error) return fail(error, "Não foi possível carregar as zonas agora.");
    return { data: ((data ?? []) as RawZone[]).map(toZone), error: null };
  },

  async saveZone(companyId, zoneId, v) {
    const { data, error } = zoneId
      ? await supabase.rpc("update_delivery_zone", {
          p_zone_id: zoneId, p_neighborhood: v.neighborhood, p_city: v.city, p_fee: v.fee, p_estimated_minutes: v.minutes, p_name: v.name || null,
        })
      : await supabase.rpc("create_delivery_zone", {
          p_company_id: companyId, p_neighborhood: v.neighborhood, p_city: v.city, p_fee: v.fee, p_estimated_minutes: v.minutes, p_name: v.name || null,
        });
    if (error) return fail(error, "Não foi possível salvar a zona agora.");
    return { data: toZone(data as RawZone), error: null };
  },

  async setZoneActive(zoneId, active) {
    const { error } = await supabase.rpc("set_delivery_zone_active", { p_zone_id: zoneId, p_active: active });
    return error ? fail(error) : { data: null, error: null };
  },

  // Pedido novo / estado / entregador / fechamento / produção dos itens: as 3 tabelas do núcleo + delivery_orders.
  subscribe(companyId, onChange) {
    return subscribeToOpenAttendanceChanges(supabase as unknown as RealtimeClientLike, companyId, onChange, "delivery-board", [
      ...OPEN_ATTENDANCE_TABLES,
      "delivery_orders",
    ]);
  },
};
