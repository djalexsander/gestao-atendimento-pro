# Gestão Atendimento Pro 1.0.20

## Novidades

- **Novo Caixa (PDV de três colunas)**: contas à esquerda em linhas compactas (comanda/mesa, cliente, tempo, atendente e valor), conferência e divisão de conta no centro, e recebimento à direita. Faixa superior com o caixa aberto, troco inicial, vendas e dinheiro esperado.
- **Pagamentos parciais e divisão de conta, incluídos no plano base**: comandas e mesas aceitam vários pagamentos, em formas diferentes (Dinheiro F1, Pix F2, Débito F3, Crédito F4, Outro F5), com troco em dinheiro. A divisão do saldo pode ser igual (com seletor de pessoas), por valores ou por produtos (matriz de produtos por pessoa), com histórico de versões. Estorno de pagamento em conta aberta somente para dono/administrador. Não há módulo nem cobrança à parte.
- **Botão único de recebimento**: com saldo pendente mostra "Registrar pagamento" (Enter); com saldo zero muda para "Fechar comanda" (Enter), sempre por uma segunda ação do operador, com proteção contra Enter repetido e duplo clique. Rodapé fixo, e em janela estreita a tela vira abas Contas / Conta / Receber.
- **Atalhos do Caixa**: F1 a F5 formas de pagamento, F8 imprimir conferência, F9 suprimento/sangria, F10 fechar caixa, Enter confirma. Leitor de código de barras não interfere nos atalhos.
- **Indicadores de pagamento**: chips de status nas comandas/mesas; o atendente vê apenas o status, nunca valores.
- **Relatórios e Dashboard**: novos blocos "recebimentos de contas ainda abertas", "correções de pagamento" e "devoluções de vendas fechadas", sem dupla contagem com as vendas; formas de pagamento mostram só vendas fechadas.
- **Desktop**: o aplicativo deixa de pausar o carregamento quando a janela fica coberta ou sem foco (menos telas em "Carregando…" e menos erros de sessão expirada).
- **Correção interna**: eliminado um impasse raro entre pedido novo e cancelamento de item com estoque controlado.

## Observações

- Empresas ativas (inclusive em período grátis, carência ou cortesia) usam o recurso automaticamente. Empresas suspensas, restritas ou em somente leitura continuam sem poder registrar pagamentos.
- Delivery, retirada e WhatsApp seguem o fluxo de sempre. O Balcão tem rota própria e não tem recursos financeiros.
- Requer a atualização do banco (já aplicada) antes da publicação do aplicativo.
