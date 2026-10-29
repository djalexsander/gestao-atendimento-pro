import { MonitoringSection } from "../features/master/whatsapp/MonitoringSection";
import { PilotSection } from "../features/master/whatsapp/PilotSection";
import { RegistrationsSection } from "../features/master/whatsapp/RegistrationsSection";
import { TokenHealthSection } from "../features/master/whatsapp/TokenHealthSection";

// Área WhatsApp do Painel Master. O acesso é do MasterRoute (is_master_admin) e TODAS as RPCs reautenticam o Admin Master no banco.
// Somente leitura + ações administrativas auditadas (piloto e resolução de registros). Não altera a trava global do Embedded Signup,
// não dispara o cron e não repete registros na Meta.
export function MasterWhatsappPage() {
  return (
    <div className="wa-master">
      <div className="mst-head">
        <h2>WhatsApp</h2>
      </div>
      <p className="mst-sub">Saúde da integração, empresas do piloto do Embedded Signup e registros de número que precisam de conferência.</p>
      <MonitoringSection />
      <TokenHealthSection />
      <PilotSection />
      <RegistrationsSection />
    </div>
  );
}
