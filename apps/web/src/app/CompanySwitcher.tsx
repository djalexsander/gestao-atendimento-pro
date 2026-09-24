import { useAuth } from "./useAuth";

export function CompanySwitcher() {
  const { companies, activeCompanyId, setActiveCompanyId } = useAuth();

  if (companies.length <= 1) return null;

  return (
    <select
      aria-label="Empresa ativa"
      className="company-switcher"
      value={activeCompanyId ?? ""}
      onChange={(e) => setActiveCompanyId(e.target.value)}
    >
      {companies.map((c) => (
        <option key={c.companyId} value={c.companyId}>
          {c.company.name}
        </option>
      ))}
    </select>
  );
}
