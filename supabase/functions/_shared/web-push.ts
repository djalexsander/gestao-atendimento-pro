// Envio de Web Push com a biblioteca web-push (npm:web-push@3.6.7). Só aqui a biblioteca é importada; as regras
// puras (payload, TTL, urgência, classificação 404/410, leitura VAPID) ficam em ./push-core.ts.
//
// Secrets lidos APENAS do ambiente do servidor (Supabase Edge Function secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: ou https:)
// Nenhuma chave em código, git ou frontend.
import webpush from "npm:web-push@3.6.7";
import { readVapidConfig, type VapidConfig, type WebPushLike } from "./push-core.ts";

export * from "./push-core.ts";

// Configuração VAPID do ambiente, ou null (função responde 503 sem tocar em nenhum evento).
export function loadVapidConfig(): VapidConfig | null {
  return readVapidConfig((name) => Deno.env.get(name));
}

// Biblioteca já configurada com a identidade VAPID da aplicação.
export function createWebPush(config: VapidConfig): WebPushLike {
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return webpush as unknown as WebPushLike;
}
