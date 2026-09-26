import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../app/useAuth";
import { fetchCompanyMembers } from "../features/employees/api";
import {
  CreateEmployeeDialog,
  CredentialDialog,
  DeleteEmployeeDialog,
  EditEmployeeDialog,
  StatusDialog,
} from "../features/employees/EmployeeDialogs";
import { assignableRoles, ROLE_LABEL } from "../features/employees/roles";
import type { CompanyMember, CompanyRole } from "../lib/types";

const STATUS_LABEL = { active: "Ativo", inactive: "Inativo" } as const;

type OpenDialog =
  | { kind: "create" }
  | { kind: "edit" | "credential" | "status" | "delete"; member: CompanyMember };

export function TeamPage() {
  const { activeCompanyId, activeMembership, user } = useAuth();
  // Só decide o que a tela MOSTRA. Quem autoriza de verdade é o backend (Edge Function
  // employee-admin + can_manage_company_user), a cada pedido.
  const roles = assignableRoles(activeMembership?.role ?? null);

  const [loaded, setLoaded] = useState<{
    companyId: string;
    members: CompanyMember[];
    error: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const load = useCallback(async () => {
    if (!activeCompanyId) return;
    const result = await fetchCompanyMembers(activeCompanyId);
    setLoaded({ companyId: activeCompanyId, members: result.data, error: result.error });
  }, [activeCompanyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!activeCompanyId) return null;

  const loading = loaded?.companyId !== activeCompanyId;
  const members = loaded?.members ?? [];

  // Ações só para funcionários com login (o dono, com e-mail próprio, fica de fora), nunca
  // na própria linha e só nas funções que quem está vendo pode gerenciar.
  function canManage(member: CompanyMember): boolean {
    return (
      member.login !== null &&
      member.user_id !== user?.id &&
      (roles as readonly CompanyRole[]).includes(member.role)
    );
  }

  function openDialog(next: OpenDialog) {
    setNotice(null);
    setDialog(next);
  }

  function handleDone(message: string) {
    setDialog(null);
    setNotice(message);
    void load();
  }

  const dialogProps = { companyId: activeCompanyId, onClose: () => setDialog(null), onDone: handleDone };

  return (
    <div>
      <div className="page-header">
        <h2>Funcionários</h2>
        {roles.length > 0 && (
          <button className="btn-primary btn-auto" type="button" onClick={() => openDialog({ kind: "create" })}>
            Novo funcionário
          </button>
        )}
      </div>

      {!loading && loaded?.error && <div className="form-error">{loaded.error}</div>}
      {notice && <div className="form-notice">{notice}</div>}

      {loading ? (
        <p>Carregando funcionários…</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Login</th>
                <th>Função</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name ?? "—"}</td>
                  <td>{member.login ?? "—"}</td>
                  <td>
                    <span className="role-badge">{ROLE_LABEL[member.role]}</span>
                  </td>
                  <td>
                    <span className={`status-badge status-${member.status}`}>{STATUS_LABEL[member.status]}</span>
                  </td>
                  <td>
                    {canManage(member) && (
                      <div className="row-actions">
                        <button
                          className="btn-secondary btn-small"
                          type="button"
                          onClick={() => openDialog({ kind: "edit", member })}
                        >
                          Editar
                        </button>
                        <button
                          className="btn-secondary btn-small"
                          type="button"
                          onClick={() => openDialog({ kind: "credential", member })}
                        >
                          Redefinir PIN/Senha
                        </button>
                        <button
                          className="btn-secondary btn-small"
                          type="button"
                          onClick={() => openDialog({ kind: "status", member })}
                        >
                          {member.status === "active" ? "Desativar" : "Ativar"}
                        </button>
                        <button
                          className="btn-secondary btn-small btn-danger-text"
                          type="button"
                          onClick={() => openDialog({ kind: "delete", member })}
                        >
                          Excluir
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === "create" && <CreateEmployeeDialog {...dialogProps} roles={roles} />}
      {dialog?.kind === "edit" && <EditEmployeeDialog {...dialogProps} member={dialog.member} roles={roles} />}
      {dialog?.kind === "credential" && <CredentialDialog {...dialogProps} member={dialog.member} />}
      {dialog?.kind === "status" && <StatusDialog {...dialogProps} member={dialog.member} />}
      {dialog?.kind === "delete" && <DeleteEmployeeDialog {...dialogProps} member={dialog.member} />}
    </div>
  );
}
