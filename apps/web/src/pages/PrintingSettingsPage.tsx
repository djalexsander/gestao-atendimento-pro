import { PrintingSettings } from "../features/printing/PrintingSettings";

// Configurações → Impressão. Só owner e admin (ver PrintingSettings).
export function PrintingSettingsPage() {
  return (
    <div>
      <h2>Impressão</h2>
      <p className="field-hint">Configure as impressoras usadas pelo estabelecimento.</p>
      <PrintingSettings />
    </div>
  );
}
