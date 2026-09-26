import { supabase } from "../../lib/supabaseClient";
import type { CompanyRow } from "../../lib/types";

export async function updateCompanyDetails(
  companyId: string,
  fields: { name: string; document: string | null },
): Promise<{ data: CompanyRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("companies")
    .update({ name: fields.name, document: fields.document })
    .eq("id", companyId)
    .select()
    .single();

  return { data: (data as CompanyRow | null) ?? null, error: error?.message ?? null };
}
