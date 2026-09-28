// Campo de código de barras + ação "Gerar EAN-13", compartilhado por todo cadastro que tenha
// barcode (Comandas/Mesas, Produtos, e futuros — ver lib/ean13.ts). Só a parte VISUAL e a
// digitação; quem decide o que a ação faz (marcar geração ao salvar, gerar na hora, regenerar
// com confirmação) é cada tela, porque isso difere entre criar e editar.

export interface BarcodeFieldAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

// O leitor de código de barras termina com Enter: no campo do código de barras isso NÃO pode
// enviar o formulário inteiro.
export function BarcodeField({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
  action,
  maxLength = 64,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  action?: BarcodeFieldAction;
  maxLength?: number;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Código de barras (opcional)</label>
      <div className="field-with-action">
        <input
          id={id}
          type="text"
          maxLength={maxLength}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
        {action && (
          <button className="btn-secondary btn-small" type="button" disabled={action.disabled} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      <span className="field-hint">{hint ?? "Clique aqui e passe o leitor, ou digite. Sem espaços."}</span>
    </div>
  );
}
