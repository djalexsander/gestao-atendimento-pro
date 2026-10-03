import { useState } from "react";
import { formatReais } from "../../lib/money";
import { Modal } from "../employees/Modal";
import {
  canAddWithoutChanges,
  extraPerUnit,
  firstSelectionError,
  groupError,
  groupHint,
  isOptionBlocked,
  selectedModifiers,
  toggleOption,
  type ModifierGroup,
  type SelectedModifier,
} from "./modifiersLogic";

export const DIALOG_NOTES_MAX = 200;

export interface ModifierChoice {
  modifiers: SelectedModifier[];
  notes: string;
  quantity: number;
}

// Escolha visual de opções (garçom): grupos na ordem configurada, opções grandes e fáceis de tocar,
// preço adicional visível, observação livre e botão de confirmar sempre visível (rodapé fixo).
// Só UX: o servidor revalida tudo (empresa, vínculo, ativo, min/max) e calcula o preço.
export function ModifierDialog({
  productName,
  basePrice,
  groups,
  mode,
  initial,
  onConfirm,
  onClose,
}: {
  productName: string;
  basePrice: number;
  groups: ModifierGroup[];
  mode: "add" | "edit";
  initial?: { optionIds: string[]; notes: string; quantity: number };
  onConfirm: (choice: ModifierChoice) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial?.optionIds ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [quantity, setQuantity] = useState(initial?.quantity ?? 1);
  const [error, setError] = useState<string | null>(null);

  const unit = Math.round((basePrice + extraPerUnit(groups, selected)) * 100) / 100;

  function confirm() {
    const problem = firstSelectionError(groups, selected);
    if (problem) {
      setError(problem);
      return;
    }
    onConfirm({ modifiers: selectedModifiers(groups, selected), notes: notes.trim(), quantity });
  }

  return (
    <Modal title={productName} onClose={onClose}>
      <div className="mod-dialog">
        <p className="mod-base-price">{formatReais(basePrice)}</p>
        <div className="mod-scroll">
          {groups.map((group) => {
            const single = group.selectionType === "single";
            const problem = error ? groupError(group, selected) : null;
            return (
              <fieldset key={group.id} className="mod-group" role={single ? "radiogroup" : "group"} aria-label={group.name}>
                <legend className="mod-group-title">
                  {group.name} <span className="mod-group-hint">{groupHint(group)}</span>
                </legend>
                <div className="mod-options">
                  {group.options.map((option) => {
                    const checked = selected.includes(option.id);
                    const blocked = isOptionBlocked(group, selected, option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role={single ? "radio" : "checkbox"}
                        aria-checked={checked}
                        disabled={blocked}
                        className={`mod-option${checked ? " mod-option-on" : ""}${option.type === "remove" ? " mod-option-remove" : ""}`}
                        onClick={() => {
                          setError(null);
                          setSelected((current) => toggleOption(group, current, option.id));
                        }}
                      >
                        <span className={`mod-mark ${single ? "mod-mark-radio" : "mod-mark-check"}`} aria-hidden="true" />
                        <span className="mod-option-name">{option.name}</span>
                        {option.priceDelta > 0 && <span className="mod-option-price">+ {formatReais(option.priceDelta)}</span>}
                      </button>
                    );
                  })}
                </div>
                {problem && <p className="mod-group-error">{problem}</p>}
              </fieldset>
            );
          })}

          <div className="field">
            <label htmlFor="mod-notes">Observação</label>
            <input
              id="mod-notes"
              type="text"
              maxLength={DIALOG_NOTES_MAX}
              placeholder="Opcional — ex.: cortar ao meio"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <div className="mod-footer">
          <div className="cart-qty">
            <button type="button" className="cart-qty-btn" aria-label="Diminuir quantidade" disabled={quantity <= 1} onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
              −
            </button>
            <span className="cart-qty-value">{quantity}</span>
            <button type="button" className="cart-qty-btn" aria-label="Aumentar quantidade" onClick={() => setQuantity((q) => q + 1)}>
              +
            </button>
          </div>
          <div className="mod-footer-actions">
            <button className="btn-secondary" type="button" onClick={onClose}>
              Cancelar
            </button>
            {mode === "add" && canAddWithoutChanges(groups) && (
              <button
                className="btn-secondary"
                type="button"
                onClick={() => onConfirm({ modifiers: [], notes: notes.trim(), quantity })}
              >
                Adicionar sem alterações
              </button>
            )}
            <button className="btn-primary btn-auto" type="button" onClick={confirm}>
              {mode === "add" ? "Adicionar ao pedido" : "Salvar alterações"} · {formatReais(unit * quantity)}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Linhas "+ Bacon", "Sem cebola" de um item (cesta, histórico). Mostra o preço só quando houver acréscimo.
export function ModifierLines({
  modifiers,
  className = "mod-lines",
}: {
  modifiers: Array<{ name: string; type: "add" | "remove"; priceDelta: number }>;
  className?: string;
}) {
  if (modifiers.length === 0) return null;
  return (
    <ul className={className}>
      {modifiers.map((m, index) => (
        <li key={`${m.name}-${index}`} className={m.type === "remove" ? "mod-line mod-line-remove" : "mod-line"}>
          {m.name}
          {m.priceDelta > 0 && <span className="mod-line-price"> · + {formatReais(m.priceDelta)}</span>}
        </li>
      ))}
    </ul>
  );
}
