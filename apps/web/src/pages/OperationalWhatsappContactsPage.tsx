import type { ContactsSource } from "../features/whatsapp/whatsappContactsApi";
import { WhatsappContacts } from "../features/whatsapp/WhatsappContacts";
import { OperationalShell } from "./OperationalPages";

// Contatos do WhatsApp (Etapa 7.4): mesma casca operacional das demais áreas, sem alterar o cabeçalho. `source` só existe para
// exercitar a tela com dados simulados.
export function OperationalWhatsappContactsPage({ source }: { source?: ContactsSource }) {
  return (
    <OperationalShell title="Contatos do WhatsApp">
      <WhatsappContacts source={source} />
    </OperationalShell>
  );
}
