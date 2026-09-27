import { useEffect, useState, type FormEvent } from "react";
import { ACCESS_CODE_LOCKED_MESSAGE, ACCESS_CODE_MAX_LENGTH, validateAccessCode } from "../../lib/accessCode";
import type { CompanyRow } from "../../lib/types";
import { supabaseAccessCodeSource, type AccessCodeSource, type AccessCodeState } from "./accessCodeApi";

const LOAD_FALLBACK = "Não foi possível verificar o código da empresa agora. Tente novamente.";

interface AccessCodeSectionProps {
  company: CompanyRow;
  canEdit: boolean;
  // Só existe para exercitar a tela com dados simulados; na rota fica o padrão (Supabase).
  source?: AccessCodeSource;
}

// "Código de acesso dos funcionários": o código que eles digitam na primeira tela de acesso
// (companies.access_code). É outra coisa que o slug. Como o código faz parte do e-mail técnico
// das contas de funcionário, ele só pode ser alterado enquanto a empresa não tem nenhum
// funcionário com login; a tela espelha essa regra, mas quem decide é o banco (RPC
// update_company_access_code + trigger de companies).
export function AccessCodeSection({ company, canEdit, source = supabaseAccessCodeSource }: AccessCodeSectionProps) {
  const [state, setState] = useState<AccessCodeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null = ainda não digitou nada: o campo mostra o código salvo.
  const [draft, setDraft] = useState<string | null>(null);
  // Código vazio só é apontado como erro depois de tentar salvar; código preenchido e inválido é
  // apontado na hora (mesmo comportamento do cadastro da empresa).
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Cada incremento pede uma nova leitura do banco (ao abrir, "Tentar novamente" e depois de cada envio).
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    void source.load(company.id).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setLoadError(result.error ?? LOAD_FALLBACK);
        return;
      }
      setLoadError(null);
      setState(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [canEdit, company.id, source, reloadTick]);

  // Sem saber se há funcionários (carregando, ou a leitura falhou) o campo fica travado: a tela
  // nunca abre uma edição que o banco recusaria.
  const savedCode = state?.accessCode ?? company.access_code ?? "";
  const hasEmployees = state?.hasEmployees === true;
  const editable = canEdit && state !== null && !hasEmployees;
  const value = editable ? (draft ?? savedCode) : savedCode;
  const trimmed = value.trim();
  const validationError = validateAccessCode(trimmed);
  const showValidationError = editable && validationError !== null && (trimmed.length > 0 || attempted);
  const unchanged = trimmed === savedCode;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setAttempted(true);
    if (!editable || saving || validationError || unchanged) return;

    setSaving(true);
    const result = await source.save(company.id, trimmed);
    if (result.error) {
      setError(result.error);
    } else {
      setDraft(null);
      setAttempted(false);
      setState({ accessCode: trimmed, hasEmployees: false });
      setNotice("Código da empresa atualizado.");
    }
    // Confirma no banco: mostra o que ficou gravado e, depois de uma recusa, trava o campo se
    // enquanto a tela estava aberta alguém cadastrou um funcionário.
    setReloadTick((tick) => tick + 1);
    setSaving(false);
  }

  const describedBy = ["settings-access-code-help"];
  if (showValidationError) describedBy.push("settings-access-code-error");
  if (hasEmployees) describedBy.push("settings-access-code-lock");

  return (
    <section className="settings-section" aria-labelledby="settings-access-code-title">
      <h3 id="settings-access-code-title" className="settings-section-title">
        Código de acesso dos funcionários
      </h3>

      {/* Se a recusa foi "travado", a tela já releu e mostra o aviso de bloqueio abaixo: sem repetir a frase. */}
      {error && !(hasEmployees && error === ACCESS_CODE_LOCKED_MESSAGE) && <div className="form-error">{error}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="settings-access-code">Código da empresa</label>
          <input
            id="settings-access-code"
            type="text"
            maxLength={ACCESS_CODE_MAX_LENGTH}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={!editable}
            value={value}
            onChange={(e) => {
              setDraft(e.target.value.toLowerCase());
              // O resultado do envio anterior (erro do banco ou "atualizado") não vale mais para o que está sendo digitado.
              setError(null);
              setNotice(null);
            }}
            aria-invalid={showValidationError}
            aria-describedby={describedBy.join(" ")}
          />
          <span id="settings-access-code-help" className="field-hint">
            Este é o código que os funcionários informam na primeira tela de acesso.
          </span>
          {showValidationError && (
            <span id="settings-access-code-error" className="field-error">
              {validationError}
            </span>
          )}
        </div>

        {hasEmployees && (
          <div id="settings-access-code-lock" className="settings-lock" role="note">
            {ACCESS_CODE_LOCKED_MESSAGE}
          </div>
        )}
        {canEdit && state === null && !loadError && (
          <p className="field-hint">Verificando os funcionários cadastrados…</p>
        )}
        {canEdit && loadError && (
          <div className="form-error">
            {loadError}{" "}
            <button
              className="btn-secondary btn-small"
              type="button"
              onClick={() => {
                setLoadError(null);
                setReloadTick((tick) => tick + 1);
              }}
            >
              Tentar novamente
            </button>
          </div>
        )}
        {!canEdit && (
          <p className="field-hint">Somente donos(as) e administradores(as) podem alterar o código da empresa.</p>
        )}
        {editable && (
          <p className="field-hint">
            Use de 3 a 32 caracteres: letras minúsculas, números e hífen entre os termos (ex.: bar-do-joao).
          </p>
        )}

        {editable && (
          <button className="btn-primary" type="submit" disabled={saving || unchanged}>
            {saving ? "Salvando…" : "Salvar código"}
          </button>
        )}
      </form>

      <p className="settings-distinction">
        <strong>Slug ≠ Código da empresa.</strong> O slug é só o identificador interno da empresa e não é usado no
        acesso dos funcionários. Alterar um não altera o outro.
      </p>
    </section>
  );
}
