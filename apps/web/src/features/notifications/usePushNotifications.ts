import { useCallback, useEffect, useState } from "react";
import { PUSH_ERROR_TEXT, PushError, type PushClient } from "./pushClient";
import { pushClient as defaultClient, readPushEnv } from "./pushBrowser";
import { defaultDeviceName, detectPlatform, reconcileState, type PushDevice, type PushState, type SectorOption } from "./pushLogic";

// Estado das notificações NESTE aparelho + ações. Nunca pede permissão sozinho: enable() só roda a partir de
// um clique (a tela liga o botão a ele). O estado combina navegador e servidor (reconcileState).
export function usePushNotifications(companyId: string | null, isProduction: boolean, client: PushClient = defaultClient) {
  const [browserState, setBrowserState] = useState<PushState>("unsupported");
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [sectors, setSectors] = useState<SectorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!companyId) return;
    const state = await client.state();
    setBrowserState(state);
    // Aparelhos só existem para quem pode usar push neste navegador.
    if (state === "subscribed" || state === "not-subscribed" || state === "denied") {
      setDevices(await client.devices(companyId));
    } else {
      setDevices([]);
    }
    setLoading(false);
  }, [client, companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!companyId || !isProduction) return;
    void client.listSectors(companyId).then(setSectors);
  }, [client, companyId, isProduction]);

  const current = devices.find((d) => d.isCurrent) ?? null;
  const state = reconcileState(browserState, current);

  const run = useCallback(
    async (action: () => Promise<string | null | void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const message = await action();
        if (typeof message === "string") setNotice(message);
      } catch (e) {
        setError(e instanceof PushError ? e.message : PUSH_ERROR_TEXT["register-failed"]);
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return {
    state,
    devices,
    current,
    sectors,
    loading,
    busy,
    error,
    notice,
    refresh,
    // Chamar SOMENTE de um onClick.
    enable: () =>
      run(async () => {
        if (!companyId) return;
        await client.enable(companyId, defaultDeviceName(detectPlatform(readPushEnv())));
        return "Notificações ativadas neste aparelho.";
      }),
    disable: () =>
      run(async () => {
        await client.disable();
        return "Notificações desativadas neste aparelho.";
      }),
    sendTest: () =>
      run(async () => {
        if (!current) return;
        const result = await client.sendTest(current.id);
        if (!result.ok) throw new PushError("test-failed", result.error ?? PUSH_ERROR_TEXT["test-failed"]);
        return "Notificação de teste enviada. Ela deve chegar em instantes.";
      }),
    saveSectors: (deviceId: string, sectorIds: string[] | null) =>
      run(async () => {
        const message = await client.setOptions(deviceId, sectorIds);
        if (message) throw new PushError("register-failed", "Não foi possível salvar os setores.");
        return "Setores salvos.";
      }),
  };
}
