import { useState, type InputHTMLAttributes } from "react";

export const SHOW_PASSWORD_LABEL = "Mostrar senha";
export const HIDE_PASSWORD_LABEL = "Ocultar senha";

/** Estado derivado da visibilidade (puro, testável): tipo do input e rótulo do botão. */
export function passwordFieldState(visible: boolean): { type: "text" | "password"; label: string } {
  return visible ? { type: "text", label: HIDE_PASSWORD_LABEL } : { type: "password", label: SHOW_PASSWORD_LABEL };
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

// Campo de senha com botão de olho (mostrar/ocultar). Começa oculto (type="password"); o valor, o onChange e todos os atributos
// do input (id, name, autoComplete, required, disabled, placeholder, className...) seguem para o <input> sem alteração. Nada
// é guardado: a visibilidade é só estado local e some com o componente. Não toca em autenticação nem em validação.
export function PasswordInput({ className, disabled, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  const { type, label } = passwordFieldState(visible);
  return (
    <div className="password-input">
      <input {...rest} className={className} disabled={disabled} type={type} />
      <button
        type="button"
        className="password-toggle"
        aria-label={label}
        aria-pressed={visible}
        title={label}
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
