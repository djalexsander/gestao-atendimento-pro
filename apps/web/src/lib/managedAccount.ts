import type { User } from "@supabase/supabase-js";

// Conta de funcionário criada pela Edge Function employee-admin. app_metadata.managed só
// é gravado pela Admin API (o cliente não consegue forjar). O e-mail dessa conta é um
// detalhe técnico do Auth e nunca deve aparecer na tela.
export function isManagedAccount(user: User | null): boolean {
  return user?.app_metadata?.managed === true;
}
