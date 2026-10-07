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
  // Item exclusivo de um módulo pago: a sidebar o mostra como "Contratar" quando a empresa não tem o módulo.
  module?: "financeiro" | "producao" | "estoque" | "impressao";
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
      { type: "item", label: "Visão financeira", path: "/app/financeiro/visao", status: "ready", module: "financeiro" },
      { type: "item", label: "Caixa", path: "/app/financeiro/caixa", status: "ready" },
      { type: "item", label: "Contas a receber", path: "/app/financeiro/contas-a-receber", status: "ready", module: "financeiro" },
      { type: "item", label: "Contas a pagar", path: "/app/financeiro/contas-a-pagar", status: "ready", module: "financeiro" },
      { type: "item", label: "Relatórios", path: "/app/financeiro/relatorios", status: "ready" },
    ],
  },
  {
    type: "group",
    id: "cadastros",
    label: "Cadastros",
    items: [
      { type: "item", label: "Produtos", path: "/app/cadastros/produtos", status: "ready" },
      { type: "item", label: "Categorias", path: "/app/cadastros/categorias", status: "ready" },
      { type: "item", label: "Adicionais / opções", path: "/app/cadastros/adicionais", status: "ready" },
      { type: "item", label: "Setores de produção", path: "/app/cadastros/setores", status: "ready", module: "producao" },
      { type: "item", label: "Estoque", path: "/app/cadastros/estoque", status: "ready", module: "estoque" },
      { type: "item", label: "Clientes", path: "/app/cadastros/clientes", status: "ready" },
      { type: "item", label: "Funcionários", path: "/app/equipe", status: "ready" },
      { type: "item", label: "Comandas / Mesas", path: "/app/comandas", status: "ready" },
    ],
  },
  {
    type: "group",
    id: "operacional",
    label: "Operacional",
    items: [
      { type: "item", label: "Comandas / Mesas abertas", path: "/operacional/atendimentos-abertos", status: "ready" },
      { type: "item", label: "Pedidos", path: "/operacional/pedidos", status: "ready" },
      { type: "item", label: "Etiquetas", path: "/operacional/etiquetas", status: "ready", module: "impressao" },
      { type: "item", label: "Produção", path: "/operacional/producao", status: "ready", module: "producao" },
      { type: "item", label: "Caixa / Balcão", path: "/operacional/caixa", status: "ready" },
    ],
  },
  {
    type: "group",
    id: "configuracoes",
    label: "Configurações",
    items: [
      { type: "item", label: "Empresa", path: "/app/configuracoes/empresa", status: "ready" },
      { type: "item", label: "Meus Planos", path: "/app/configuracoes/meus-planos", status: "ready" },
      { type: "item", label: "Código de acesso", path: "/app/configuracoes/codigo-acesso", status: "ready" },
      { type: "item", label: "Modo de atendimento", path: "/app/configuracoes/modo-atendimento", status: "ready" },
      { type: "item", label: "Impressão", path: "/app/configuracoes/impressao", status: "ready", module: "impressao" },
      { type: "item", label: "Notificações", path: "/app/configuracoes/notificacoes", status: "ready" },
      { type: "item", label: "Sistema / Preferências", path: "/app/configuracoes/sistema", status: "ready" },
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
