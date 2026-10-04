import { useCallback, useEffect, useRef, useState } from "react";
import { AUTO_REGISTER_FAILED_TEXT, PUSH_ERROR_TEXT, PushError, type PushClient } from "./pushClient";
import { pushClient as defaultClient, readPushEnv } from "./pushBrowser";
import {
  canSaveDraft,
  defaultDeviceName,
  detectPlatform,
  draftFromSaved,
  draftToValue,
  isSectorsDirty,
  reconcileState,
  toggleAllInDraft,
  toggleSectorInDraft,
  type PushDevice,
  type PushState,
  type SectorDraft,
  type SectorOption,
} from "./pushLogic";

export const SAVE_OK_TEXT = "Configurações salvas.";
export const SAVE_ERROR_TEXT = "Não foi possível salvar as configurações. Tente novamente.";

// Estado das notificações NESTE aparelho + ações. Nunca pede permissão sozinho: enable() só roda a partir de um
// clique (a tela liga o botão a ele). O estado combina navegador e servidor (reconcileState). Se a permissão já foi
// concedida e a assinatura física existe, ao abrir o painel reassocia sozinho ao usuário atual (sem clique e sem
// prompt), a menos que o usuário tenha desativado este aparelho de propósito.
//
// Setores: o SERVIDOR é a fonte da verdade (a linha deste usuário neste aparelho). A tela edita um RASCUNHO e só grava
// em "Salvar configurações"; o rascunho é descartado ao trocar de aparelho/usuário e mantido se o salvamento falhar.
export function usePushNotifications(companyId: string | null, userId: string | null, isProduction: boolean, client: PushClient = defaultClient) {
  const [browserState, setBrowserState] = useState<PushState>("unsupported");
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [sectors, setSectors] = useState<SectorOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [optedOut, setOptedOut] = useState(false);
  // rascunho de setores, atrelado ao aparelho ao qual pertence (null = sem edição pendente)
  const [draftState, setDraftState] = useState<{ deviceId: string; value: SectorDraft } | null>(null);
  const savingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!companyId || !userId) return;
    const state = await client.state();
    setBrowserState(state);
    let list: PushDevice[] = [];
    // Aparelhos só existem para quem pode usar push neste navegador.
    if (state === "subscribed" || state === "not-subscribed" || state === "denied") list = await client.devices(companyId);
    // Permissão concedida + assinatura física, mas o servidor não tem a associação ATIVA deste usuário: reassocia.
    if (state === "subscribed" && !list.some((d) => d.isCurrent && d.isActive)) {
      const result = await client.autoRegister(companyId, userId);
      if (result === "registered") list = await client.devices(companyId);
      else if (result === "failed") setError(AUTO_REGISTER_FAILED_TEXT);
    }
    setDevices(list);
    setOptedOut(client.isOptedOut(userId));
    setLoading(false);
  }, [client, companyId, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!companyId || !isProduction) return;
    void client.listSectors(companyId).then(setSectors);
  }, [client, companyId, isProduction]);

  const current = devices.find((d) => d.isCurrent) ?? null;
  const state = reconcileState(browserState, current);

  // Valor SALVO no servidor para este aparelho e rascunho atual (o rascunho só vale para o aparelho atual).
  const saved = current?.sectorIds ?? null;
  const draft: SectorDraft = draftState && current && draftState.deviceId === current.id ? draftState.value : draftFromSaved(saved, sectors);
  const dirty = Boolean(draftState && current && draftState.deviceId === current.id && isSectorsDirty(draftState.value, saved, sectors));
  const canSave = dirty && canSaveDraft(draft) && !saving;

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
    saving,
    error,
    notice,
    optedOut,
    refresh,
    // setores: rascunho x salvo
    draft,
    savedSectors: saved,
    dirty,
    canSave,
    toggleAllSectors: () => {
      if (!current) return;
      setNotice(null);
      setDraftState({ deviceId: current.id, value: toggleAllInDraft(draft, sectors) });
    },
    toggleSector: (sectorId: string) => {
      if (!current) return;
      setNotice(null);
      setDraftState({ deviceId: current.id, value: toggleSectorInDraft(draft, sectorId, sectors) });
    },
    // Salva SÓ as preferências deste aparelho (set_push_device_options). Evita clique duplo; erro mantém o rascunho.
    saveConfig: async () => {
      if (!current || savingRef.current || !canSaveDraft(draft)) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const message = await client.setOptions(current.id, draftToValue(draft, sectors), null);
        if (message) {
          setError(SAVE_ERROR_TEXT);
          return;
        }
        setDraftState(null);
        await refresh();
        setNotice(SAVE_OK_TEXT);
      } catch {
        setError(SAVE_ERROR_TEXT);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    // Chamar SOMENTE de um onClick.
    enable: () =>
      run(async () => {
        if (!companyId) return;
        await client.enable(companyId, defaultDeviceName(detectPlatform(readPushEnv())), userId);
        return "Notificações ativadas neste aparelho.";
      }),
    disable: () =>
      run(async () => {
        await client.disable(userId);
        setDraftState(null);
        return "Notificações desativadas neste aparelho.";
      }),
    sendTest: () =>
      run(async () => {
        if (!current) return;
        const result = await client.sendTest(current.id);
        if (!result.ok) throw new PushError("test-failed", result.error ?? PUSH_ERROR_TEXT["test-failed"]);
        return "Notificação de teste enviada. Ela deve chegar em instantes.";
      }),
  };
}
