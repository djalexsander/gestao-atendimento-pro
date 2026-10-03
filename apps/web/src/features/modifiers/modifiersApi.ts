import { supabase } from "../../lib/supabaseClient";
import { describeModifierError, type ModifierGroup, type ModifierOption, type ModifierType, type SelectionType } from "./modifiersLogic";

const LOAD_ERROR = "Não foi possível carregar os adicionais agora. Tente novamente.";
const SAVE_ERROR = "Não foi possível salvar agora. Tente novamente.";
const NOT_FOUND_OR_NO_PERMISSION = "Não foi possível alterar: o item não existe mais, ou você não tem permissão.";

export interface AdminModifierGroup extends ModifierGroup {
  productIds: string[];
}

export interface GroupInput {
  name: string;
  selectionType: SelectionType;
  minSelection: number;
  maxSelection: number | null;
  sortOrder: number;
}

export interface OptionInput {
  name: string;
  type: ModifierType;
  priceDelta: number;
  sortOrder: number;
}

export interface ProductLite {
  id: string;
  name: string;
}

// Fonte de dados do cadastro de adicionais (owner/admin; RLS + GRANT por coluna da migration 20261002010000).
// Recebida por parâmetro para exercitar a tela com dados simulados.
export interface ModifiersAdminSource {
  load(companyId: string): Promise<{ data: { groups: AdminModifierGroup[]; products: ProductLite[] } | null; error: string | null }>;
  createGroup(companyId: string, input: GroupInput): Promise<{ error: string | null }>;
  updateGroup(groupId: string, input: GroupInput): Promise<{ error: string | null }>;
  setGroupActive(groupId: string, active: boolean): Promise<{ error: string | null }>;
  createOption(companyId: string, groupId: string, input: OptionInput): Promise<{ error: string | null }>;
  updateOption(optionId: string, input: OptionInput): Promise<{ error: string | null }>;
  setOptionActive(optionId: string, active: boolean): Promise<{ error: string | null }>;
  setOptionOrder(updates: Array<{ id: string; sortOrder: number }>): Promise<{ error: string | null }>;
  linkProduct(companyId: string, groupId: string, productId: string): Promise<{ error: string | null }>;
  unlinkProduct(groupId: string, productId: string): Promise<{ error: string | null }>;
}

async function write(request: PromiseLike<{ data: unknown[] | null; error: { code?: string | null; message?: string | null } | null }>): Promise<{ error: string | null }> {
  const { data, error } = await request;
  if (error) return { error: describeModifierError(error, SAVE_ERROR) };
  return { error: data && data.length > 0 ? null : NOT_FOUND_OR_NO_PERMISSION };
}

export const supabaseModifiersAdminSource: ModifiersAdminSource = {
  async load(companyId) {
    const [groupsRes, optionsRes, linksRes, productsRes] = await Promise.all([
      supabase.from("product_modifier_groups").select("id, name, selection_type, min_selection, max_selection, sort_order, is_active").eq("company_id", companyId),
      supabase.from("product_modifier_options").select("id, group_id, name, modifier_type, price_delta, sort_order, is_active").eq("company_id", companyId),
      supabase.from("product_modifier_group_products").select("group_id, product_id").eq("company_id", companyId),
      supabase.from("products").select("id, name").eq("company_id", companyId).order("name"),
    ]);
    if (groupsRes.error || optionsRes.error || linksRes.error || productsRes.error) {
      console.error("Falha ao carregar adicionais (admin):", groupsRes.error?.code ?? optionsRes.error?.code ?? linksRes.error?.code ?? productsRes.error?.code);
      return { data: null, error: LOAD_ERROR };
    }
    const options = new Map<string, ModifierOption[]>();
    for (const o of optionsRes.data ?? []) {
      const list = options.get(o.group_id) ?? [];
      list.push({ id: o.id, groupId: o.group_id, name: o.name, type: o.modifier_type, priceDelta: Number(o.price_delta), sortOrder: o.sort_order, isActive: o.is_active });
      options.set(o.group_id, list);
    }
    const links = new Map<string, string[]>();
    for (const l of linksRes.data ?? []) links.set(l.group_id, [...(links.get(l.group_id) ?? []), l.product_id]);
    const groups: AdminModifierGroup[] = (groupsRes.data ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      selectionType: g.selection_type,
      minSelection: g.min_selection,
      maxSelection: g.max_selection,
      sortOrder: g.sort_order,
      isActive: g.is_active,
      options: (options.get(g.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR")),
      productIds: links.get(g.id) ?? [],
    }));
    groups.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR"));
    return { data: { groups, products: (productsRes.data ?? []) as ProductLite[] }, error: null };
  },

  async createGroup(companyId, input) {
    const { error } = await supabase.from("product_modifier_groups").insert({
      company_id: companyId,
      name: input.name,
      selection_type: input.selectionType,
      min_selection: input.minSelection,
      max_selection: input.maxSelection,
      sort_order: input.sortOrder,
    });
    return { error: error ? describeModifierError(error, SAVE_ERROR) : null };
  },

  updateGroup: (groupId, input) =>
    write(
      supabase
        .from("product_modifier_groups")
        .update({ name: input.name, selection_type: input.selectionType, min_selection: input.minSelection, max_selection: input.maxSelection, sort_order: input.sortOrder })
        .eq("id", groupId)
        .select("id"),
    ),

  setGroupActive: (groupId, active) => write(supabase.from("product_modifier_groups").update({ is_active: active }).eq("id", groupId).select("id")),

  async createOption(companyId, groupId, input) {
    const { error } = await supabase.from("product_modifier_options").insert({
      company_id: companyId,
      group_id: groupId,
      name: input.name,
      modifier_type: input.type,
      price_delta: input.type === "remove" ? 0 : input.priceDelta,
      sort_order: input.sortOrder,
    });
    return { error: error ? describeModifierError(error, SAVE_ERROR) : null };
  },

  updateOption: (optionId, input) =>
    write(
      supabase
        .from("product_modifier_options")
        .update({ name: input.name, modifier_type: input.type, price_delta: input.type === "remove" ? 0 : input.priceDelta, sort_order: input.sortOrder })
        .eq("id", optionId)
        .select("id"),
    ),

  setOptionActive: (optionId, active) => write(supabase.from("product_modifier_options").update({ is_active: active }).eq("id", optionId).select("id")),

  async setOptionOrder(updates) {
    for (const u of updates) {
      const result = await write(supabase.from("product_modifier_options").update({ sort_order: u.sortOrder }).eq("id", u.id).select("id"));
      if (result.error) return result;
    }
    return { error: null };
  },

  async linkProduct(companyId, groupId, productId) {
    const { error } = await supabase.from("product_modifier_group_products").insert({ company_id: companyId, group_id: groupId, product_id: productId });
    if (error?.code === "23505") return { error: null }; // já vinculado
    return { error: error ? describeModifierError(error, SAVE_ERROR) : null };
  },

  async unlinkProduct(groupId, productId) {
    const { error } = await supabase.from("product_modifier_group_products").delete().eq("group_id", groupId).eq("product_id", productId);
    return { error: error ? describeModifierError(error, SAVE_ERROR) : null };
  },
};
