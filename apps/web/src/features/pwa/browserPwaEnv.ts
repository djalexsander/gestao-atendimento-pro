import { WEB_VERSION, isTauri } from "../../lib/appVersion";
import { fetchPublishedVersion, type PwaUpdateEnv, type SwRegistrationLike } from "./pwaUpdateLogic";

/** Ambiente real do navegador para o controlador (tudo que toca DOM/service worker fica aqui). */
export function browserPwaEnv(): PwaUpdateEnv {
  return {
    runningVersion: WEB_VERSION,
    isDesktop: () => isTauri(),
    fetchPublishedVersion: () => fetchPublishedVersion(),
    getRegistration: async (): Promise<SwRegistrationLike | undefined> => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
      try {
        return (await navigator.serviceWorker.getRegistration()) ?? undefined;
      } catch {
        return undefined;
      }
    },
    waitForControllerChange: (ms) =>
      new Promise<boolean>((resolve) => {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return resolve(false);
        const done = (value: boolean) => {
          window.clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("controllerchange", onChange);
          resolve(value);
        };
        const onChange = () => done(true);
        const timer = window.setTimeout(() => done(false), ms);
        navigator.serviceWorker.addEventListener("controllerchange", onChange);
      }),
    reload: () => window.location.reload(),
    on: (event, cb) => {
      if (event === "visible") {
        const h = () => {
          if (document.visibilityState === "visible") cb();
        };
        document.addEventListener("visibilitychange", h);
        return () => document.removeEventListener("visibilitychange", h);
      }
      const name = event === "focus" ? "focus" : "online";
      window.addEventListener(name, cb);
      return () => window.removeEventListener(name, cb);
    },
    every: (ms, cb) => {
      const id = window.setInterval(cb, ms);
      return () => window.clearInterval(id);
    },
    now: () => Date.now(),
  };
}
