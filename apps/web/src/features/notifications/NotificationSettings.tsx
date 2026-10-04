import { useAuth } from "../../app/useAuth";
import type { PushClient } from "./pushClient";
import {
  DENIED_TEXT,
  describeLastUsed,
  deviceStatusLabel,
  deviceTitle,
  IOS_INSTALL_MESSAGE,
  isSectorChecked,
  PLATFORM_LABEL,
  roleNotificationSummary,
  sectorSummary,
  STATE_LABEL,
  toggleSector,
  UNSUPPORTED_TEXT,
  unsupportedReason,
  type PushDevice,
  type PushState,
} from "./pushLogic";
import { readPushEnv } from "./pushBrowser";
import { usePushNotifications } from "./usePushNotifications";

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

function statusHint(state: PushState): string {
  switch (state) {
    case "subscribed":
      return "Este aparelho vai receber as notificações do seu papel.";
    case "not-subscribed":
      return "Ative para receber avisos neste aparelho, mesmo com o app fechado (quando o sistema permitir).";
    case "denied":
      return DENIED_TEXT;
    case "ios-not-installed":
      return IOS_INSTALL_MESSAGE;
    default: {
      const reason = unsupportedReason(readPushEnv());
      return UNSUPPORTED_TEXT[reason ?? "browser"];
    }
  }
}

function DeviceRow({ device, isProduction, sectors, onToggleSector, onAll, busy }: {
  device: PushDevice;
  isProduction: boolean;
  sectors: Array<{ id: string; name: string }>;
  onToggleSector: (sectorId: string) => void;
  onAll: () => void;
  busy: boolean;
}) {
  return (
    <li className="push-device">
      <div className="push-device-head">
        <strong>{deviceTitle(device)}</strong>
        {device.isCurrent && <span className="rec-badge">Este aparelho</span>}
        <span className={device.isActive ? "rec-badge rec-badge-paid" : "rec-badge"}>{deviceStatusLabel(device)}</span>
      </div>
      <small className="muted">
        {PLATFORM_LABEL[device.platform]} · {describeLastUsed(device.lastUsedAt)} · cadastrado em {dateTime.format(new Date(device.createdAt))}
      </small>
      {isProduction && (
        <div className="push-sectors">
          <small className="muted">Setores: {sectorSummary(device.sectorIds, sectors)}</small>
          {device.isCurrent && device.isActive && sectors.length > 0 && (
            <div className="push-sector-list" role="group" aria-label="Setores acompanhados neste aparelho">
              <label className="checkbox-row">
                <input type="checkbox" checked={device.sectorIds === null} disabled={busy} onChange={onAll} />
                Todos os setores
              </label>
              {sectors.map((s) => (
                <label key={s.id} className="checkbox-row">
                  <input type="checkbox" checked={isSectorChecked(device.sectorIds, s.id)} disabled={busy} onChange={() => onToggleSector(s.id)} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Painel de notificações do aparelho. Mesmo componente na página administrativa (/app/configuracoes/notificacoes)
// e no modal das telas operacionais. A permissão do navegador SÓ é pedida no clique de "Ativar notificações".
export function NotificationSettings({ client }: { client?: PushClient }) {
  const { activeMembership } = useAuth();
  const companyId = activeMembership?.companyId ?? null;
  const role = activeMembership?.role ?? null;
  const isProduction = role === "production";
  const push = usePushNotifications(companyId, isProduction, client);
  const { state, current } = push;

  if (push.loading) return <p className="op-state">Carregando…</p>;

  return (
    <div className="push-settings">
      <div className="fin-card push-status">
        <div className="push-status-head">
          <h3>Notificações neste aparelho</h3>
          <span className={`rec-badge ${state === "subscribed" ? "rec-badge-paid" : state === "denied" ? "rec-badge-overdue" : ""}`}>{STATE_LABEL[state]}</span>
        </div>
        <p className="push-hint">{statusHint(state)}</p>
        <p className="field-hint">{roleNotificationSummary(role)}</p>

        {push.error && <div className="form-error">{push.error}</div>}
        {push.notice && <div className="rec-notice" role="status">{push.notice}</div>}

        <div className="push-actions">
          {state === "not-subscribed" && (
            <button className="btn-primary btn-auto" type="button" disabled={push.busy} onClick={() => void push.enable()}>
              {push.busy ? "Ativando…" : "Ativar notificações"}
            </button>
          )}
          {state === "subscribed" && (
            <>
              <button className="btn-primary btn-auto" type="button" disabled={push.busy || !current} onClick={() => void push.sendTest()}>
                {push.busy ? "Enviando…" : "Enviar notificação de teste"}
              </button>
              <button className="btn-secondary btn-auto" type="button" disabled={push.busy} onClick={() => void push.disable()}>
                Desativar neste aparelho
              </button>
            </>
          )}
        </div>
        <p className="field-hint">
          A entrega depende do aparelho e do sistema (economia de bateria, modo Foco, permissões) e não é garantida nem instantânea.
        </p>
      </div>

      {push.devices.length > 0 && (
        <div className="fin-card">
          <h3>Meus aparelhos</h3>
          <ul className="push-devices">
            {push.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                isProduction={isProduction}
                sectors={push.sectors}
                busy={push.busy}
                onAll={() => void push.saveSectors(d.id, null)}
                onToggleSector={(sectorId) => void push.saveSectors(d.id, toggleSector(d.sectorIds, sectorId, push.sectors))}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
