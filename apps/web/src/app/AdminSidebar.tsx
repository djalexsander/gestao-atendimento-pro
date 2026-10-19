import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { AppVersionLabel } from "../features/about/AppVersionLabel";
import { ADMIN_NAV, groupContaining, type NavGroup } from "./adminNav";
import { moduleAccess } from "../features/commercial/commercialLogic";
import { useCommercial } from "../features/commercial/CommercialProvider";
import { useAuth } from "./useAuth";
import { useDrawer } from "./useDrawer";

// Sidebar administrativa (owner/admin — a rota /app já garante isso, ver accessRules.ts). Grupos
// abrem sozinhos ao entrar numa rota filha e continuam abrindo/fechando por clique; nenhum grupo
// fecha sozinho (evita fechar algo que a pessoa abriu de propósito). `open`/`onNavigate` controlam
// o drawer no celular/tablet (≤900px); no desktop `open` é ignorado (a sidebar é sempre fixa e acompanha a rolagem).
export function AdminSidebar({
  id,
  open,
  onClose,
  onNavigate,
  openerRef,
  footer,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  onNavigate: () => void;
  openerRef: RefObject<HTMLElement | null>;
  /** Só aparece no drawer (celular/tablet): identidade, papel, troca de empresa e sair. */
  footer?: ReactNode;
}) {
  const { activeMembership } = useAuth();
  const drawerRef = useRef<HTMLElement>(null);
  useDrawer({ open, onClose, drawerRef, openerRef });
  const { entitlements } = useCommercial();
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
            {group.items
              .filter((item) => !(item.hideWhenLocked && item.module && moduleAccess(entitlements, item.module) !== "allowed"))
              .map((item) => (
              <li key={item.path + item.label}>
                <NavLink
                  to={item.path}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) => `admin-nav-link${isActive ? " admin-nav-link-active" : ""}`}
                >
                  {item.label}
                  {item.status === "placeholder" && <span className="admin-nav-soon">em breve</span>}
                  {item.module && moduleAccess(entitlements, item.module) === "locked" && <span className="admin-nav-soon">contratar</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <nav id={id} ref={drawerRef} className={`admin-sidebar${open ? " admin-sidebar-open" : ""}`} aria-label="Navegação administrativa">
      <div className="admin-sidebar-header">
        <div className="admin-sidebar-title">
          <div className="admin-brand">Gestão Atendimento Pro</div>
          <div className="admin-company">{activeMembership?.company.name}</div>
        </div>
        <button type="button" className="admin-drawer-close" aria-label="Fechar menu" onClick={onClose}>
          ✕
        </button>
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
      {footer && <div className="admin-sidebar-footer">{footer}</div>}
      <AppVersionLabel />
    </nav>
  );
}
