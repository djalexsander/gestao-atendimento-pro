// Notificações push do PWA Gestão Atendimento Pro.
//
// Carregado dentro do service worker gerado pelo Workbox via `workbox.importScripts` (vite.config.ts): o VitePWA
// usa a estratégia generateSW, então não há sw.ts para receber estes listeners; importScripts é a forma
// documentada de estendê-lo sem trocar de estratégia. Roda no MESMO worker do precache: não mexe em caches.
//
// Payload esperado do servidor (push-dispatch / push-test): { title, body, url, notificationId }.
// Dedupe visual: notificationId vira a `tag` (a mesma tag substitui a notificação em vez de empilhar).

const APP_TITLE = "Gestão Atendimento Pro";
const NAVIGATE_MESSAGE = "PUSH_NAVIGATE";

// Só rota interna do app: começa com "/" (nunca "//", barra invertida ou caractere de controle).
function safePath(url) {
  if (typeof url !== "string") return "/";
  const value = url.trim();
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  return value.length > 500 ? "/" : value;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  if (!data || typeof data !== "object") data = {};

  const title = typeof data.title === "string" && data.title ? data.title : APP_TITLE;
  const tag = typeof data.notificationId === "string" && data.notificationId ? data.notificationId : undefined;
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag,
    // com tag, avisa de novo se um aparelho receber o mesmo id outra vez
    renotify: Boolean(tag),
    data: { url: safePath(data.url) },
  };

  // userVisibleOnly: toda push PRECISA mostrar uma notificação (exigência dos navegadores e do iOS).
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Não depende de client.navigate (falha em PWA no iOS): o app navega pelo router ao receber a mensagem.
        client.postMessage({ type: NAVIGATE_MESSAGE, url });
        if ("focus" in client) {
          try {
            await client.focus();
            return;
          } catch {
            /* tenta o próximo cliente / abre uma janela */
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
