import { useEffect, useState } from "react";
import { getAppVersion, isTauri, WEB_VERSION, type AppVersion } from "./appVersion";

// Versão a exibir. No PWA já nasce com a versão do build (sem flash e sem tocar no Tauri); no Desktop troca pela versão real
// do executável assim que a API responde.
export function useAppVersion(): AppVersion {
  const [value, setValue] = useState<AppVersion>({ version: WEB_VERSION, runtime: isTauri() ? "desktop" : "web" });
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getAppVersion().then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return value;
}
