import { useEffect, useState } from "react";
import { supabaseOrderNoticeSource, type OrderNoticeSource } from "./orderNoticeApi";
import { noticeBadge, type OrderNotice } from "./orderNoticeLogic";

// Selo informativo do aviso automático do pedido pelo WhatsApp. Não tem botão, não bloqueia nada e some quando o pedido não
// tem aviso (balcão, mesa, sem vínculo, recurso desligado). Atualiza sozinho quando o aviso muda.
export function OrderWhatsappNotice({ serviceOrderId, source = supabaseOrderNoticeSource }: { serviceOrderId: string; source?: OrderNoticeSource }) {
  const [rows, setRows] = useState<OrderNotice[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void source.list(serviceOrderId).then((r) => {
        if (alive) setRows(r);
      }).catch(() => undefined);
    };
    load();
    const off = source.subscribe(serviceOrderId, load);
    return () => {
      alive = false;
      off();
    };
  }, [source, serviceOrderId]);

  const badge = noticeBadge(rows);
  if (!badge) return null;
  return (
    <span className={`wa-notice wa-notice-${badge.tone}`} title={badge.hint} role="status">
      {badge.text}
    </span>
  );
}
