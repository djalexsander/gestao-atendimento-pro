import { PAYMENT_METHODS, type PaymentMethod } from "./cashLogic";

// PDV do Caixa (v1.0.20): cinco botões lado a lado (nome + atalho) no lugar do seletor da forma de pagamento.
// Só desenha e avisa a escolha; quem decide valor, troco e validação continua sendo o formulário/controlador do recebimento.
export const PAYMENT_BUTTON_LABEL: Record<PaymentMethod, string> = { cash: "Dinheiro", pix: "Pix", debit_card: "Débito", credit_card: "Crédito", other: "Outro" };
export const PAYMENT_METHOD_KEY: Record<PaymentMethod, string> = { cash: "F1", pix: "F2", debit_card: "F3", credit_card: "F4", other: "F5" };

export function PaymentMethodButtons({
  value,
  onSelect,
  disabled = false,
  ariaLabel = "Forma de pagamento",
}: {
  value: PaymentMethod | null;   // null = nenhuma escolhida ainda
  onSelect: (method: PaymentMethod) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="pay-methods" role="radiogroup" aria-label={ariaLabel} data-testid="pay-methods">
      {PAYMENT_METHODS.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          className={value === m ? "pay-method pay-method-on" : "pay-method"}
          disabled={disabled}
          data-method={m}
          onClick={() => onSelect(m)}
        >
          <span className="pay-method-name">{PAYMENT_BUTTON_LABEL[m]}</span>
          <kbd className="pay-method-key">{PAYMENT_METHOD_KEY[m]}</kbd>
        </button>
      ))}
    </div>
  );
}
