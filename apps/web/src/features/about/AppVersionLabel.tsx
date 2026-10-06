import { useAppVersion } from "../../lib/useAppVersion";

// Versão discreta no rodapé da sidebar (Desktop e PWA mostram o mesmo formato: v1.0.2).
export function AppVersionLabel() {
  const { version } = useAppVersion();
  return (
    <div className="admin-version" title="Versão do aplicativo">
      v{version}
    </div>
  );
}
