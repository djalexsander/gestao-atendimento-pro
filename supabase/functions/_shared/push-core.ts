// Núcleo PURO do envio de Web Push (sem imports): classificação do resultado, montagem do payload, leitura da
// configuração VAPID e comparação do segredo interno. A biblioteca web-push entra só em ./web-push.ts, para que
// estas regras sejam testáveis em qualquer runtime.
//
// A chave VAPID PRIVADA só é lida aqui, do ambiente do servidor (secrets da Edge Function). Nunca vai para o
// frontend, para o banco nem para o git.

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  // rota do app aberta no toque (sempre relativa; o service worker valida de novo)
  url: string;
  // vira a `tag` da notificação no aparelho (dedupe visual)
  notificationId: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// ok = entregue ao serviço de push; gone = 404/410 (assinatura não existe mais); error = qualquer outra falha.
export type SendOutcome = "ok" | "gone" | "error";

export interface SendResult {
  outcome: SendOutcome;
  statusCode?: number;
}

// Biblioteca de envio (assinatura compatível com web-push).
export interface WebPushLike {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { TTL: number; urgency: "very-low" | "low" | "normal" | "high" },
  ): Promise<unknown>;
}

// Pedidos precisam chegar logo; o resto pode esperar. TTL curto: pedido velho não interessa.
export const TTL_SECONDS: Record<"order" | "default", number> = { order: 3600, default: 86400 };

export function classifyStatus(statusCode: number | undefined): SendOutcome {
  if (statusCode === 404 || statusCode === 410) return "gone";
  return "error";
}

export function buildPayload(message: PushMessage): string {
  return JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url,
    notificationId: message.notificationId,
  });
}

// Lê VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT do ambiente do SERVIDOR. null = não configurado.
// O subject precisa ser mailto: ou https: (exigência dos serviços de push, inclusive da Apple).
export function readVapidConfig(getEnv: (name: string) => string | undefined): VapidConfig | null {
  const publicKey = getEnv("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = getEnv("VAPID_PRIVATE_KEY")?.trim();
  const subject = getEnv("VAPID_SUBJECT")?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export interface SendOptions {
  kind: "order" | "default";
}

// Envia UMA notificação e devolve só o resultado (nunca lança, nunca devolve credenciais).
export async function sendOne(
  lib: WebPushLike,
  target: PushTarget,
  message: PushMessage,
  options: SendOptions,
): Promise<SendResult> {
  try {
    await lib.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      buildPayload(message),
      { TTL: TTL_SECONDS[options.kind], urgency: options.kind === "order" ? "high" : "normal" },
    );
    return { outcome: "ok" };
  } catch (error) {
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    return { outcome: classifyStatus(statusCode), statusCode };
  }
}

// --- Segredo interno (chamadas do banco para push-dispatch) -----------------------------------

export type InternalAuthorization = "authorized" | "misconfigured" | "unauthorized";

const MINIMUM_SECRET_LENGTH = 32;

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function authorizeInternalRequest(configuredSecret: string | undefined, received: string | null): InternalAuthorization {
  if (!configuredSecret || configuredSecret.length < MINIMUM_SECRET_LENGTH) return "misconfigured";
  if (!received) return "unauthorized";
  return constantTimeEqual(configuredSecret, received) ? "authorized" : "unauthorized";
}
