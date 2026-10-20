// Aviso automático do pedido pelo WhatsApp — lógica PURA do selo mostrado à operação (produção/delivery).
// O selo é só informativo: nunca bloqueia nem muda a operação. Não mostra texto da mensagem nem telefone.
export type NoticeStatus = "pending" | "processing" | "sent" | "blocked_window" | "skipped" | "expired" | "superseded" | "failed";
export type NoticeType = "ORDER_READY_PICKUP" | "ORDER_READY_DELIVERY" | "OUT_FOR_DELIVERY";

export interface OrderNotice {
  type: NoticeType;
  status: NoticeStatus;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export type NoticeTone = "ok" | "wait" | "warn";
export interface NoticeBadge {
  tone: NoticeTone;
  text: string;
  hint: string;
}

const TYPE_LABEL: Record<NoticeType, string> = {
  ORDER_READY_PICKUP: "pedido pronto",
  ORDER_READY_DELIVERY: "pedido pronto",
  OUT_FOR_DELIVERY: "saiu para entrega",
};

/** 'skipped' (recurso desligado, sem vínculo válido) e 'superseded' (trocado pelo aviso de saída) não aparecem para a operação. */
export function visibleNotices(rows: OrderNotice[]): OrderNotice[] {
  return rows.filter((n) => n.status !== "skipped" && n.status !== "superseded");
}

/** O selo vem do aviso MAIS RECENTE visível (ex.: "saiu para entrega" depois de "pronto"). Sem aviso: nada é mostrado. */
export function noticeBadge(rows: OrderNotice[]): NoticeBadge | null {
  const list = visibleNotices(rows).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const n = list[0];
  if (!n) return null;
  const what = TYPE_LABEL[n.type];
  switch (n.status) {
    case "sent":
      return { tone: "ok", text: "WhatsApp: ✓ Cliente avisado", hint: n.deliveredAt ? `Aviso de ${what} entregue ao cliente.` : `Aviso de ${what} enviado.` };
    case "pending":
    case "processing":
      return { tone: "wait", text: "WhatsApp: avisando o cliente…", hint: `Aviso de ${what} em envio.` };
    case "blocked_window":
      return { tone: "warn", text: "⚠ Não foi possível avisar", hint: `O cliente está fora da janela de 24 h do WhatsApp (${what}). Avise por outro meio, se precisar.` };
    case "expired":
      return { tone: "warn", text: "⚠ Não foi possível avisar", hint: `O aviso de ${what} venceu sem ser enviado.` };
    case "failed":
    default:
      return { tone: "warn", text: "⚠ Não foi possível avisar", hint: `O WhatsApp não aceitou o aviso de ${what}.` };
  }
}

export interface RawNotice {
  notification_type: NoticeType;
  status: NoticeStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
}
export const toNotice = (r: RawNotice): OrderNotice => ({
  type: r.notification_type,
  status: r.status,
  attempts: r.attempts,
  createdAt: r.created_at,
  sentAt: r.sent_at,
  deliveredAt: r.delivered_at,
});
