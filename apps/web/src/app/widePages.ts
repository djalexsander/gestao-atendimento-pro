// Largura da área de conteúdo das páginas administrativas.
//  - largas: tabelas/listas que pedem a largura maior (1200px); as demais seguem em 720px.
//  - fluidas (SÓ no Desktop/Tauri): ocupam toda a área ao lado do menu lateral. A decisão usa a identificação real do ambiente
//    (isTauri), nunca a largura da tela: Web/PWA — inclusive no computador — não mudam.
export const WIDE_PATHS = ["/app", "/app/configuracoes/notificacoes", "/app/financeiro/visao", "/app/financeiro/contas-a-receber", "/app/financeiro/contas-a-pagar", "/app/financeiro/caixa", "/app/cadastros/estoque", "/app/cadastros/clientes", "/app/configuracoes/sistema", "/app/financeiro/relatorios", "/app/configuracoes/impressao"];

export const TAURI_FLUID_PATHS = [
  "/app/cadastros/produtos",
  "/app/cadastros/categorias",
  "/app/cadastros/adicionais",
  "/app/cadastros/setores",
  "/app/equipe",
  "/app/comandas",
];

const normalize = (pathname: string) => pathname.replace(/\/+$/, "");

export function isWidePath(pathname: string): boolean {
  return WIDE_PATHS.includes(normalize(pathname));
}

export function isFluidPath(pathname: string, tauri: boolean): boolean {
  return tauri && TAURI_FLUID_PATHS.includes(normalize(pathname));
}

// Classe do <main> do AppLayout. "app-body-fluid" só existe no Desktop (o CSS dela está todo escopado nessa classe).
export function bodyClass(pathname: string, tauri: boolean): string {
  if (isFluidPath(pathname, tauri)) return "app-body app-body-fluid";
  return isWidePath(pathname) ? "app-body app-body-wide" : "app-body";
}
