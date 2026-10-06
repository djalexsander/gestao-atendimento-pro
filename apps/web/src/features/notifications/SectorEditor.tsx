import { isSectorChecked, type SectorDraft, type SectorOption } from "./pushLogic";

// Editor de setores do aparelho ATUAL (production). As marcações editam um rascunho; só "Salvar configurações" grava.
export function SectorEditor({ draft, sectors, dirty, canSave, saving, onAll, onToggle, onSave }: {
  draft: SectorDraft;
  sectors: SectorOption[];
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  onAll: () => void;
  onToggle: (sectorId: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="push-sector-editor">
      <div className="push-sector-list" role="group" aria-label="Setores acompanhados neste aparelho">
        <label className="checkbox-row">
          <input type="checkbox" checked={draft.all} disabled={saving} onChange={onAll} />
          Todos os setores
        </label>
        {sectors.map((s) => (
          <label key={s.id} className="checkbox-row">
            <input type="checkbox" checked={isSectorChecked(draft, s.id)} disabled={saving} onChange={() => onToggle(s.id)} />
            {s.name}
          </label>
        ))}
      </div>
      <div className="push-save-row">
        {dirty && <span className="push-unsaved" role="status">Alterações não salvas</span>}
        <button className="btn-primary btn-auto" type="button" disabled={!canSave} onClick={onSave}>
          {saving ? "Salvar configurações..." : "Salvar configurações"}
        </button>
      </div>
    </div>
  );
}
