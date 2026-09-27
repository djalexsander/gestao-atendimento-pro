// Estrutura da navegação administrativa (sidebar). Só dados, sem React: quem renderiza é
// AdminSidebar; quem decide se a rota pode ser vista continua sendo o guard (accessRules.ts) —
// esta lista não é segurança, é só o que aparece no menu.
//
// "ready" = rota já implementada de verdade; "placeholder" = ainda não existe, mostra a página
// "Em construção" (ModulePlaceholderPage). Rotas "ready" que apontam para o MESMO path (ex.:
// Empresa e Código de acesso, os dois em /app/configuracoes) reaproveitam a página existente —
// nenhum componente é duplicado.
export type NavStatus = "ready" | "placeholder";

export interface NavLeaf {
  type: "item";
  label: string;
  path: string;
  status: NavStatus;
  // Só para placeholders que merecem uma explicação melhor que o texto genérico
  // (ex.: "essa configuração já existe, só que em outra tela").
  note?: string;
}

export interface NavGroup {
  type: "group";
  id: string;
  label: string;
  items: NavLeaf[];
}

export type NavEntry = NavLeaf | NavGroup;

export const ADMIN_NAV: NavEntry[] = [
  { type: "item", label: "Dashboard", path: "/app", status: "ready" },
  {
    type: "group",
    id: "financeiro",
    label: "Financeiro",
    items: [
      { type: "item", label: "Visão financeira", path: "/app/financeiro/visao", status: "placeholder" },
      { type: "item", label: "Caixa", path: "/app/financeiro/caixa", status: "placeholder" },
      { type: "item", label: "Contas a receber", path: "/app/financeiro/contas-a-receber", status: "placeholder" },
      { type: "item", label: "Contas a pagar", path: "/app/financeiro/contas-a-pagar", status: "placeholder" },
      { type: "item", label: "Relatórios financeiros", path: "/app/financeiro/relatorios", status: "placeholder" },
    ],
  },
  {
    type: "group",
    id: "cadastros",
    label: "Cadastros",
    items: [
      { type: "item", label: "Produtos", path: "/app/cadastros/produtos", status: "placeholder" },
      { type: "item", label: "Categorias", path: "/app/cadastros/categorias", status: "placeholder" },
      { type: "item", label: "Setores de produção", path: "/app/cadastros/setores", status: "placeholder" },
      { type: "item", label: "Clientes", path: "/app/cadastros/clientes", status: "placeholder" },
      { type: "item", label: "Funcionários", path: "/app/equipe", status: "ready" },
      { type: "item", label: "Comandas / Mesas", path: "/app/comandas", status: "ready" },
    ],
  },
  {
    type: "group",
    id: "operacional",
    label: "Operacional",
    items: [
      { type: "item", label: "Comandas / Mesas abertas", path: "/app/operacional/comandas-abertas", status: "placeholder" },
      { type: "item", label: "Pedidos", path: "/app/operacional/pedidos", status: "placeholder" },
      { type: "item", label: "Produção", path: "/app/operacional/producao", status: "placeholder" },
      { type: "item", label: "Caixa / Balcão", path: "/app/operacional/caixa", status: "placeholder" },
    ],
  },
  {
    type: "group",
    id: "configuracoes",
    label: "Configurações",
    items: [
      { type: "item", label: "Empresa", path: "/app/configuracoes/empresa", status: "ready" },
      { type: "item", label: "Código de acesso", path: "/app/configuracoes/codigo-acesso", status: "ready" },
      { type: "item", label: "Modo de atendimento", path: "/app/configuracoes/modo-atendimento", status: "ready" },
      { type: "item", label: "Impressoras", path: "/app/configuracoes/impressoras", status: "placeholder" },
      { type: "item", label: "Sistema / Preferências", path: "/app/configuracoes/sistema", status: "placeholder" },
    ],
  },
];

// O grupo que contém um path (ou null se for o item direto Dashboard, ou nenhum bater).
export function groupContaining(path: string): string | null {
  for (const entry of ADMIN_NAV) {
    if (entry.type === "group" && entry.items.some((item) => item.path === path)) return entry.id;
  }
  return null;
}
