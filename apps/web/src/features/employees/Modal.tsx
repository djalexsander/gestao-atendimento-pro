import { useEffect, useRef, type ReactNode } from "react";

// Janela modal sobre o <dialog> nativo: o navegador cuida do foco, do fundo e do ESC.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h3>{title}</h3>
      {children}
    </dialog>
  );
}
