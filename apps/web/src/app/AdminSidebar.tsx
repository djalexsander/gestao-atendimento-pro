import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { AppVersionLabel } from "../features/about/AppVersionLabel";
import { ADMIN_NAV, groupContaining, type NavGroup } from "./adminNav";
import { useAuth } from "./useAuth";

// Sidebar administrativa (owner/admin — a rota /app já garante isso, ver accessRules.ts). Grupos
// abrem sozinhos ao entrar numa rota filha e continuam abrindo/fechando por clique; nenhum grupo
// fecha sozinho (evita fechar algo que a pessoa abriu de propósito). `open`/`onNavigate` controlam
// o drawer no mobile; no desktop `open` é ignorado (a sidebar é sempre fixa).
export function AdminSidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { activeMembership } = useAuth();
  const { pathname } = useLocation();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const current = groupContaining(pathname);
    return new Set(current ? [current] : []);
  });

  useEffect(() => {
    const current = groupContaining(pathname);
    if (!current) return;
    setOpenGroups((prev) => (prev.has(current) ? prev : new Set(prev).add(current)));
  }, [pathname]);

  function toggleGroup(id: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderGroup(group: NavGroup) {
    const isOpen = openGroups.has(group.id);
    return (
      <div className="admin-nav-group" key={group.id}>
        <button
          type="button"
          className="admin-nav-group-toggle"
          aria-expanded={isOpen}
          onClick={() => toggleGroup(group.id)}
        >
          <span>{group.label}</span>
          <span className={`admin-nav-chevron${isOpen ? " admin-nav-chevron-open" : ""}`} aria-hidden="true">
            ›
          </span>
        </button>
        {isOpen && (
          <ul className="admin-nav-group-items">
            {group.items.map((item) => (
              <li key={item.path + item.label}>
                <NavLink
                  to={item.path}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) => `admin-nav-link${isActive ? " admin-nav-link-active" : ""}`}
                >
                  {item.label}
                  {item.status === "placeholder" && <span className="admin-nav-soon">em breve</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <nav className={`admin-sidebar${open ? " admin-sidebar-open" : ""}`} aria-label="Navegação administrativa">
      <div className="admin-sidebar-header">
        <div className="admin-brand">Gestão Atendimento Pro</div>
        <div className="admin-company">{activeMembership?.company.name}</div>
      </div>
      <div className="admin-nav-scroll">
        {ADMIN_NAV.map((entry) =>
          entry.type === "item" ? (
            <NavLink
              key={entry.path}
              to={entry.path}
              end
              onClick={onNavigate}
              className={({ isActive }) => `admin-nav-link admin-nav-link-top${isActive ? " admin-nav-link-active" : ""}`}
            >
              {entry.label}
            </NavLink>
          ) : (
            renderGroup(entry)
          ),
        )}
      </div>
      <AppVersionLabel />
    </nav>
  );
}
