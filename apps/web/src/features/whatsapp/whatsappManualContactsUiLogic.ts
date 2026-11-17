// Estado PURO da interface dos contatos manuais (Etapa 7.10F): qual painel está aberto e textos fixos. Sem React, sem Supabase.
// Toda regra de negócio fica no servidor e em whatsappManualContactsLogic.ts; aqui só a navegação entre painéis.
import type { ManualContactDetail, ManualContactError } from "./whatsappManualContactsLogic";

/** Painel aberto sobre a lista. 'confirm' só existe dentro de 'view' (arquivar/restaurar pedem confirmação). */
export type ManualPanel =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "view"; contactId: string; confirm: "archive" | "restore" | "delete" | null }
  | { mode: "edit"; contactId: string }
  | { mode: "link"; contactId: string };

export const CLOSED_PANEL: ManualPanel = { mode: "closed" };

export type ManualPanelAction =
  | { type: "create" }
  | { type: "view"; contactId: string }
  | { type: "edit" }
  | { type: "link" }
  | { type: "confirm"; what: "archive" | "restore" | "delete" | null }
  | { type: "back" }
  | { type: "close" };

export function panelReducer(panel: ManualPanel, action: ManualPanelAction): ManualPanel {
  switch (action.type) {
    case "create":
      return { mode: "create" };
    case "view":
      return { mode: "view", contactId: action.contactId, confirm: null };
    case "close":
      return CLOSED_PANEL;
    case "edit":
      return panel.mode === "view" ? { mode: "edit", contactId: panel.contactId } : panel;
    case "link":
      return panel.mode === "view" ? { mode: "link", contactId: panel.contactId } : panel;
    case "confirm":
      return panel.mode === "view" ? { ...panel, confirm: action.what } : panel;
    case "back":
      // editar/vincular voltam ao detalhe; o detalhe e a criação fecham
      return panel.mode === "edit" || panel.mode === "link" ? { mode: "view", contactId: panel.contactId, confirm: null } : CLOSED_PANEL;
  }
}

export const panelContactId = (p: ManualPanel): string | null => (p.mode === "view" || p.mode === "edit" || p.mode === "link" ? p.contactId : null);

/** Detalhe carregado do servidor para o painel (com o id a que pertence, para descartar respostas de outro contato). */
export type DetailState =
  | { id: string; status: "loading" }
  | { id: string; status: "ready"; data: ManualContactDetail }
  | { id: string; status: "error"; error: ManualContactError };

export const MANUAL_TEXT = {
  newContact: "Novo contato",
  createTitle: "Novo contato",
  editTitle: "Editar contato",
  detailTitle: "Contato",
  linkTitle: "Vincular cliente",
  nameLabel: "Nome",
  phoneLabel: "Telefone",
  phoneHint: "Com DDD, ex.: (44) 99999-8888. Para outro país, comece com + e o código do país.",
  notesLabel: "Observações",
  notesHint: "Visíveis para quem tem acesso ao WhatsApp da empresa. Opcional.",
  save: "Salvar",
  saving: "Salvando…",
  cancel: "Cancelar",
  close: "Fechar",
  edit: "Editar",
  linkCustomer: "Vincular cliente",
  changeCustomer: "Trocar cliente",
  unlinkCustomer: "Desvincular",
  archive: "Arquivar",
  restore: "Restaurar",
  confirmArchive: "Arquivar este contato? Ele deixa de aparecer na lista. Conversas e clientes não são alterados e você pode restaurá-lo depois.",
  confirmRestore: "Restaurar este contato? Ele volta a aparecer na lista.",
  noNotes: "Sem observações.",
  noCustomer: "Nenhum cliente vinculado.",
  noteNoConversation: "Cadastrar um contato não cria conversa nem envia mensagem.",
  openExisting: "Ver contato existente",
  nothingToSave: "Nada foi alterado.",
  loadingDetail: "Carregando contato…",
  linkHelp: "Escolha um cliente já cadastrado e ativo. Nenhum cliente novo é criado aqui.",
  archivedBadge: "Arquivado",
  deleteForever: "Excluir definitivamente",
  confirmDelete: "Esta ação apaga o contato e as observações definitivamente e NÃO pode ser desfeita. Clientes, conversas e mensagens não são apagados.",
  deleteTypeLabel: "Para confirmar, digite EXCLUIR",
} as const;

export const NOTICES = {
  created: "Contato cadastrado.",
  updated: "Contato atualizado.",
  archived: "Contato arquivado.",
  restored: "Contato restaurado.",
  linked: "Cliente vinculado.",
  unlinked: "Cliente desvinculado.",
  unchanged: "Nada foi alterado.",
  deleted: "Contato excluído definitivamente.",
} as const;
