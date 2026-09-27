// Página genérica para qualquer item da sidebar que ainda não tem tela própria. Uma só
// implementação, reaproveitada por todas as rotas placeholder (ver App.tsx).
export function ModulePlaceholderPage({ title, note }: { title: string; note?: string }) {
  return (
    <div className="page-placeholder">
      <h2>{title}</h2>
      <p className="page-placeholder-text">
        {note ?? "Esta área ainda está em construção. Em breve você vai poder usá-la por aqui."}
      </p>
    </div>
  );
}
