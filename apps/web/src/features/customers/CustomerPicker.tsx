import { useEffect, useRef, useState } from "react";
import { supabaseCustomersSource, type CustomersSource } from "./customersApi";
import { digitsOnly, type CustomerOption } from "./customersLogic";

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

// Escolha de cliente em atendimentos e contas a receber. Três caminhos, nenhum obrigatório:
//   1) digitar livremente (o texto vira o nome — comportamento de sempre);
//   2) escolher um cliente ativo da lista (busca por nome ou telefone; devolve só nome e final do telefone);
//   3) cadastrar rápido o nome digitado (nome + telefone opcional).
// A busca só roda a partir de 2 caracteres, com pequena espera.
export function CustomerPicker({
  companyId,
  inputId,
  label,
  maxLength,
  text,
  onTextChange,
  selected,
  onSelect,
  autoFocus,
  allowQuickCreate = true,
  source = supabaseCustomersSource,
}: {
  companyId: string;
  inputId: string;
  label: string;
  maxLength: number;
  text: string;
  onTextChange: (value: string) => void;
  selected: CustomerOption | null;
  onSelect: (customer: CustomerOption | null) => void;
  autoFocus?: boolean;
  // false = só busca/seleção/texto livre (preferência da empresa; o servidor também recusa).
  allowQuickCreate?: boolean;
  source?: CustomersSource;
}) {
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickPhone, setQuickPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  const term = text.trim();

  useEffect(() => {
    if (selected || term.length < MIN_CHARS) {
      seq.current++;
      setOptions([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    const id = ++seq.current;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const result = await source.search(companyId, term);
      if (id !== seq.current) return;
      setSearching(false);
      setSearched(true);
      if (result.error || !result.data) {
        setMessage(result.error);
        setOptions([]);
        return;
      }
      setMessage(null);
      setOptions(result.data);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term, selected, companyId, source]);

  function choose(option: CustomerOption) {
    onSelect(option);
    onTextChange(option.name);
    setOptions([]);
    setQuickOpen(false);
    setMessage(null);
  }

  async function quickCreate() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    const phone = digitsOnly(quickPhone);
    const result = await source.quickCreate(companyId, term, phone === "" ? null : phone);
    setSaving(false);
    if (result.error || !result.data) {
      setMessage(result.error);
      return;
    }
    setQuickPhone("");
    choose(result.data);
  }

  if (selected) {
    return (
      <div className="field">
        <label htmlFor={inputId}>{label}</label>
        <div className="cus-selected" id={inputId}>
          <span>
            <strong>{selected.name}</strong>
            {selected.phoneLast4 && <small className="muted"> · tel. final {selected.phoneLast4}</small>}
            <small className="muted"> · cadastrado</small>
          </span>
          <button
            type="button"
            className="btn-secondary btn-auto"
            onClick={() => {
              onSelect(null);
              onTextChange("");
            }}
          >
            Trocar
          </button>
        </div>
      </div>
    );
  }

  const showEmpty = searched && !searching && options.length === 0 && term.length >= MIN_CHARS;

  return (
    <div className="field cus-picker">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="text"
        autoComplete="off"
        autoFocus={autoFocus}
        maxLength={maxLength}
        placeholder="Digite o nome ou telefone para buscar"
        value={text}
        onChange={(e) => {
          onTextChange(e.target.value);
          setQuickOpen(false);
        }}
      />
      {message && <div className="form-error">{message}</div>}
      {searching && <p className="field-hint">Buscando…</p>}
      {options.length > 0 && (
        <ul className="cus-options" aria-label="Clientes encontrados">
          {options.map((o) => (
            <li key={o.id}>
              <button type="button" className="cus-option" onClick={() => choose(o)}>
                <span>{o.name}</span>
                {o.phoneLast4 && <small className="muted">tel. final {o.phoneLast4}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {showEmpty && !quickOpen && <p className="field-hint">Nenhum cliente cadastrado com esse nome. Você pode usar o texto digitado assim mesmo.</p>}
      {allowQuickCreate && term.length >= MIN_CHARS && !quickOpen && (
        <button type="button" className="btn-link cus-quick-link" onClick={() => setQuickOpen(true)}>
          Cadastrar “{term}” como cliente
        </button>
      )}
      {allowQuickCreate && quickOpen && (
        <div className="cus-quick">
          <p className="field-hint">
            Novo cliente: <strong>{term}</strong>
          </p>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            aria-label="Telefone (opcional)"
            placeholder="Telefone com DDD (opcional)"
            maxLength={16}
            value={quickPhone}
            onChange={(e) => setQuickPhone(e.target.value)}
          />
          <div className="cus-quick-actions">
            <button type="button" className="btn-secondary btn-auto" disabled={saving} onClick={() => setQuickOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn-primary btn-auto" disabled={saving} onClick={() => void quickCreate()}>
              {saving ? "Cadastrando…" : "Cadastrar e usar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
