import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { detectNewMessageIds, fillPlan, isNearBottom, OWN_SEND_WINDOW_MS, planMessageScroll, type MessageRow } from "./whatsappLogic";

// Rolagem do chat (Fase 3). A área de mensagens tem rolagem PRÓPRIA; nunca se usa scrollIntoView (ele rola também a página
// externa). A decisão de rolar vem de regras puras (whatsappLogic). Só mensagens com id novo contam: status/erro não.
export function useChatScroll(conversationId: string | null, messages: MessageRow[] | null) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const seen = useRef<Set<string> | null>(null);
  const ownSendAt = useRef<number | null>(null);
  const unreadRef = useRef(0);
  const [unread, setUnreadState] = useState(0);
  const setUnread = useCallback((n: number) => {
    unreadRef.current = n;
    setUnreadState((cur) => (cur === n ? cur : n));
  }, []);

  const toEnd = useCallback((smooth: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // trocar de conversa: nada vaza (contador, posição, envio pendente, ids vistos)
  useLayoutEffect(() => {
    seen.current = null;
    nearBottom.current = true;
    ownSendAt.current = null;
    setUnread(0);
  }, [conversationId, setUnread]);

  // chegada de mensagens: antes da pintura, para nunca "abrir no topo e pular"
  useLayoutEffect(() => {
    if (!messages) return;
    const prev = seen.current;
    const ids = detectNewMessageIds(prev, messages);
    const newMessages = messages.filter((m) => ids.includes(m.id));
    const next = new Set(prev ?? []);
    for (const m of messages) next.add(m.id);
    seen.current = next;
    const el = scrollerRef.current;
    const near = el ? isNearBottom(el) : nearBottom.current;
    const own = ownSendAt.current !== null && Date.now() - ownSendAt.current < OWN_SEND_WINDOW_MS;
    const plan = planMessageScroll({ firstLoad: prev === null, newMessages, nearBottom: near, ownSendPending: own, unread: unreadRef.current });
    if (plan.consumedOwnSend) ownSendAt.current = null;
    if (plan.scrollToEnd) {
      toEnd(false);
      nearBottom.current = true;
    }
    setUnread(plan.unread);
  }, [messages, toEnd, setUnread]);

  // o painel mudou de altura (composer cresceu, teclado abriu): quem estava no fim continua vendo a última mensagem
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    nearBottom.current = near;
    if (near && unreadRef.current > 0) setUnread(0); // chegou ao fim lendo: nada mais é "novo"
  }, [setUnread]);

  const jumpToEnd = useCallback(() => {
    toEnd(true);
    nearBottom.current = true;
    setUnread(0);
  }, [toEnd, setUnread]);

  const notifyOwnSend = useCallback(() => {
    ownSendAt.current = Date.now();
  }, []);

  return { scrollerRef, unread, onScroll, jumpToEnd, notifyOwnSend };
}

/** Faz o elemento ocupar o que sobra da janela (usa o visual viewport: acompanha o teclado virtual). */
export function useFillViewport(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const apply = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const parent = el.parentElement;
      const pad = parent ? parseFloat(getComputedStyle(parent).paddingBottom) || 0 : 0;
      const plan = fillPlan(vv?.height ?? window.innerHeight, top, pad + 4);
      el.style.height = `${plan.height}px`;
      if (plan.scrollPageTo !== null && Math.abs(window.scrollY - plan.scrollPageTo) > 2) window.scrollTo({ top: plan.scrollPageTo });
    };
    apply();
    const raf = requestAnimationFrame(apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    vv?.addEventListener("resize", apply);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      vv?.removeEventListener("resize", apply);
    };
  }, [ref]);
}
