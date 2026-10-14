import { useCallback, useEffect, useState } from "react";
import { formatReais } from "../../lib/money";
import { supabaseDeliverySource, type DeliverySource } from "./deliveryApi";
import {
  parseMinutes,
  parseMoney,
  zoneFormProblem,
  type DeliverySettings as Settings,
  type ZoneForm,
  type ZoneRow,
} from "./deliveryLogic";

const EMPTY_ZONE: ZoneForm = { name: "", neighborhood: "", city: "", fee: "", minutes: "" };

// Configurações → Delivery (owner/admin): opções do módulo e zonas de entrega. A autoridade (papel, módulo, validação)
// é do banco; a tela só dá retorno rápido.
export function DeliverySettings({ companyId, source = supabaseDeliverySource }: { companyId: string; source?: DeliverySource }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [delivery, setDelivery] = useState("45");
  const [pickup, setPickup] = useState("30");
  const [fee, setFee] = useState("");
  const [instr, setInstr] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [zones, setZones] = useState<ZoneRow[] | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState<{ id: string | null; form: ZoneForm } | null>(null);
  const [zoneSaving, setZoneSaving] = useState(false);

  const applySettings = (s: Settings) => {
    setSettings(s);
    setDelivery(String(s.deliveryMinutes));
    setPickup(String(s.pickupMinutes));
    setFee(s.defaultFee === null ? "" : s.defaultFee.toFixed(2).replace(".", ","));
    setInstr(s.defaultInstructions);
  };

  const loadAll = useCallback(async () => {
    const [s, z] = await Promise.all([source.settings(companyId), source.zones(companyId)]);
    if (s.data) applySettings(s.data);
    else setLoadError(s.error);
    if (z.data) setZones(z.data);
    else setZoneError(z.error);
  }, [source, companyId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function save() {
    if (!settings) return;
    const dm = parseMinutes(delivery);
    const pm = parseMinutes(pickup);
    const df = fee.trim() ? parseMoney(fee) : null;
    if (dm === null) return setMessage({ kind: "err", text: "O tempo de entrega deve ficar entre 1 e 1440 minutos." });
    if (pm === null) return setMessage({ kind: "err", text: "O tempo de retirada deve ficar entre 1 e 1440 minutos." });
    if (fee.trim() && df === null) return setMessage({ kind: "err", text: "Taxa padrão inválida. Use zero ou mais, ex.: 8,00." });
    setSaving(true);
    setMessage(null);
    const r = await source.updateSettings(companyId, { ...settings, deliveryMinutes: dm, pickupMinutes: pm, defaultFee: df, defaultInstructions: instr });
    setSaving(false);
    if (r.data) {
      applySettings(r.data);
      setMessage({ kind: "ok", text: "Configurações salvas." });
    } else setMessage({ kind: "err", text: r.error });
  }

  async function saveZone() {
    if (!zoneForm) return;
    const p = zoneFormProblem(zoneForm.form);
    if (p) return setZoneError(p);
    setZoneSaving(true);
    setZoneError(null);
    const f = zoneForm.form;
    const r = await source.saveZone(companyId, zoneForm.id, {
      name: f.name.trim(),
      neighborhood: f.neighborhood.trim(),
      city: f.city.trim(),
      fee: parseMoney(f.fee) ?? 0,
      minutes: f.minutes.trim() ? parseMinutes(f.minutes) : null,
    });
    setZoneSaving(false);
    if (!r.data) return setZoneError(r.error);
    setZoneForm(null);
    await loadAll();
  }

  async function toggleZone(z: ZoneRow) {
    const r = await source.setZoneActive(z.id, !z.isActive);
    if (r.error) return setZoneError(r.error);
    await loadAll();
  }

  if (loadError) return <div className="form-error" role="alert">{loadError}</div>;
  if (!settings) return <p className="muted">Carregando…</p>;

  return (
    <div className="dl-settings">
      <section className="dl-card-box">
        <h3>Opções do Delivery</h3>
        <label className="dl-check"><input type="checkbox" checked={settings.deliveryEnabled} onChange={(e) => setSettings({ ...settings, deliveryEnabled: e.target.checked })} /> Entrega ativa</label>
        <label className="dl-check"><input type="checkbox" checked={settings.pickupEnabled} onChange={(e) => setSettings({ ...settings, pickupEnabled: e.target.checked })} /> Retirada ativa</label>
        <label className="dl-check"><input type="checkbox" checked={settings.allowManualFee} onChange={(e) => setSettings({ ...settings, allowManualFee: e.target.checked })} /> Permitir ajuste manual da taxa</label>
        <div className="dl-grid2">
          <label className="dl-field"><span>Tempo padrão de entrega (min)</span><input inputMode="numeric" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></label>
          <label className="dl-field"><span>Tempo padrão de retirada (min)</span><input inputMode="numeric" value={pickup} onChange={(e) => setPickup(e.target.value)} /></label>
          <label className="dl-field"><span>Taxa padrão (opcional)</span><input inputMode="decimal" placeholder="Sem taxa padrão" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
        </div>
        <label className="dl-field dl-field-wide">
          <span>Instrução padrão (opcional)</span>
          <textarea rows={2} maxLength={500} value={instr} onChange={(e) => setInstr(e.target.value)} />
        </label>
        <p className="field-hint">Regra da taxa: zona ativa do bairro; senão a taxa padrão; senão ajuste manual (se permitido).</p>
        {message && <div className={message.kind === "ok" ? "form-notice" : "form-error"} role={message.kind === "ok" ? "status" : "alert"}>{message.text}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-primary btn-auto" disabled={saving} onClick={() => void save()}>{saving ? "Salvando…" : "Salvar configurações"}</button>
        </div>
      </section>

      <section className="dl-card-box">
        <div className="dl-zones-head">
          <h3>Zonas de entrega</h3>
          <button type="button" className="btn-secondary" onClick={() => { setZoneError(null); setZoneForm({ id: null, form: { ...EMPTY_ZONE } }); }}>Nova zona</button>
        </div>
        {zoneError && <div className="form-error" role="alert">{zoneError}</div>}
        {zoneForm && (
          <form className="dl-addr-form" onSubmit={(e) => { e.preventDefault(); void saveZone(); }}>
            {(
              [["name", "Nome (opcional)"], ["neighborhood", "Bairro"], ["city", "Cidade"], ["fee", "Taxa (R$)"], ["minutes", "Previsão (min, opcional)"]] as Array<[keyof ZoneForm, string]>
            ).map(([k, l]) => (
              <label key={k} className="dl-field">
                <span>{l}</span>
                <input value={zoneForm.form[k]} inputMode={k === "fee" || k === "minutes" ? "decimal" : undefined} onChange={(e) => setZoneForm({ ...zoneForm, form: { ...zoneForm.form, [k]: e.target.value } })} />
              </label>
            ))}
            <div className="modal-actions dl-field-wide">
              <button type="button" className="btn-secondary" onClick={() => setZoneForm(null)}>Cancelar</button>
              <button type="submit" className="btn-primary btn-auto" disabled={zoneSaving}>{zoneSaving ? "Salvando…" : "Salvar zona"}</button>
            </div>
          </form>
        )}
        {zones === null ? (
          <p className="muted">Carregando zonas…</p>
        ) : zones.length === 0 ? (
          <p className="muted">Nenhuma zona cadastrada. Sem zona, vale a taxa padrão ou o ajuste manual.</p>
        ) : (
          <ul className="dl-zone-list">
            {zones.map((z) => (
              <li key={z.id} className={z.isActive ? "" : "dl-zone-off"}>
                <span className="dl-zone-main">
                  <strong>{z.name}</strong>
                  <span className="muted">{z.neighborhood} · {z.city}</span>
                </span>
                <span>{formatReais(z.fee)}</span>
                <span className="muted">{z.estimatedMinutes ? `${z.estimatedMinutes} min` : "tempo padrão"}</span>
                <span className={`status-badge ${z.isActive ? "status-active" : "status-inactive"}`}>{z.isActive ? "Ativa" : "Inativa"}</span>
                <span className="dl-addr-actions">
                  <button type="button" className="btn-secondary btn-small" onClick={() => { setZoneError(null); setZoneForm({ id: z.id, form: { name: z.name, neighborhood: z.neighborhood, city: z.city, fee: String(z.fee).replace(".", ","), minutes: z.estimatedMinutes ? String(z.estimatedMinutes) : "" } }); }}>Editar</button>
                  <button type="button" className="btn-secondary btn-small" onClick={() => void toggleZone(z)}>{z.isActive ? "Desativar" : "Ativar"}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
