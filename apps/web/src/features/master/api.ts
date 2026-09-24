import { supabase } from "../../lib/supabaseClient";
import type { MasterCompanyRow, MasterOverview } from "../../lib/types";

// Ambas as funções chamam RPCs SECURITY DEFINER que reautenticam
// master_admin internamente (assert_master_admin()) — mesmo que alguém
// chame estas funções sem ser master_admin, a RPC recusa no backend.

export async function fetchMasterOverview(): Promise<{
  data: MasterOverview | null;
  error: string | null;
}> {
  const { data, error } = await supabase.rpc("master_get_overview");
  if (error) return { data: null, error: error.message };

  const row = (Array.isArray(data) ? data[0] : data) as {
    total_companies: number;
    total_users: number;
    active_companies: number;
  } | null;

  if (!row) return { data: null, error: null };

  return {
    data: {
      totalCompanies: Number(row.total_companies),
      totalUsers: Number(row.total_users),
      activeCompanies: Number(row.active_companies),
    },
    error: null,
  };
}

export async function fetchMasterCompanies(): Promise<{
  data: MasterCompanyRow[];
  error: string | null;
}> {
  const { data, error } = await supabase.rpc("master_list_companies");
  if (error) return { data: [], error: error.message };

  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    document: string | null;
    created_at: string;
    member_count: number;
  }>;

  return {
    data: rows.map((r) => ({
      id: r.id,
      name: r.name,
      document: r.document,
      createdAt: r.created_at,
      memberCount: Number(r.member_count),
    })),
    error: null,
  };
}
