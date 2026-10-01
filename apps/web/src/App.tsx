import { CashAdmin } from "./features/cash/CashAdmin";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./app/AppLayout";
import { MasterLayout } from "./app/MasterLayout";
import {
  AppRoute,
  DisabledAccessRoute,
  GuestOnlyRoute,
  MasterRoute,
  OnboardingRoute,
  OperationalRoute,
  RootRedirect,
} from "./app/routeGuards";
import { AccessCodeSettingsPage } from "./pages/AccessCodeSettingsPage";
import { AccessDisabledPage } from "./pages/AccessDisabledPage";
import { AppHomePage } from "./pages/AppHomePage";
import { CompanySettingsPage } from "./pages/CompanySettingsPage";
import { EmployeeLoginPage } from "./pages/EmployeeLoginPage";
import { LoginPage } from "./pages/LoginPage";
import { MasterCompaniesPage } from "./pages/MasterCompaniesPage";
import { MasterCompanyDetailPage } from "./pages/MasterCompanyDetailPage";
import { MasterInvoiceDetailPage } from "./pages/MasterInvoiceDetailPage";
import { MasterInvoicesPage } from "./pages/MasterInvoicesPage";
import { MasterModulesPage } from "./pages/MasterModulesPage";
import { MasterOverviewPage } from "./pages/MasterOverviewPage";
import { MasterPlansPage } from "./pages/MasterPlansPage";
import { ModulePlaceholderPage } from "./pages/ModulePlaceholderPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import {
  OperationalCashierOrderPage,
  OperationalProductionPage,
  OperationalCashierPage,
  OperationalServiceOrderPage,
  OperationalServicePage,
} from "./pages/OperationalPages";
import { PrintingSettingsPage } from "./pages/PrintingSettingsPage";
import { ProductCategoriesPage } from "./pages/ProductCategoriesPage";
import { ProductionSectorsPage } from "./pages/ProductionSectorsPage";
import { ReportsRoutePage } from "./pages/ReportsRoutePage";
import { StockPage } from "./pages/StockPage";
import { ProductsPage } from "./pages/ProductsPage";
import { ServiceModeSettingsPage } from "./pages/ServiceModeSettingsPage";
import { ServicePointsAdminPage } from "./pages/ServicePointsAdminPage";
import { SignupPage } from "./pages/SignupPage";
import { TeamPage } from "./pages/TeamPage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route
        path="/login"
        element={
          <GuestOnlyRoute>
            <LoginPage />
          </GuestOnlyRoute>
        }
      />
      <Route
        path="/cadastro"
        element={
          <GuestOnlyRoute>
            <SignupPage />
          </GuestOnlyRoute>
        }
      />
      <Route
        path="/funcionario"
        element={
          <GuestOnlyRoute>
            <EmployeeLoginPage />
          </GuestOnlyRoute>
        }
      />
      <Route
        path="/onboarding"
        element={
          <OnboardingRoute>
            <OnboardingPage />
          </OnboardingRoute>
        }
      />
      <Route
        path="/acesso-desativado"
        element={
          <DisabledAccessRoute>
            <AccessDisabledPage />
          </DisabledAccessRoute>
        }
      />
      <Route
        path="/operacional/atendimento"
        element={
          <OperationalRoute area="atendimento">
            <OperationalServicePage />
          </OperationalRoute>
        }
      />
      <Route
        path="/operacional/atendimento/:sessionId"
        element={
          <OperationalRoute area="atendimento">
            <OperationalServiceOrderPage />
          </OperationalRoute>
        }
      />
      <Route
        path="/operacional/producao"
        element={
          <OperationalRoute area="producao">
            <OperationalProductionPage />
          </OperationalRoute>
        }
      />
      <Route
        path="/operacional/caixa"
        element={
          <OperationalRoute area="caixa">
            <OperationalCashierPage />
          </OperationalRoute>
        }
      />
      <Route
        path="/operacional/caixa/:sessionId"
        element={
          <OperationalRoute area="caixa">
            <OperationalCashierOrderPage />
          </OperationalRoute>
        }
      />
      <Route
        path="/app"
        element={
          <AppRoute>
            <AppLayout />
          </AppRoute>
        }
      >
        <Route index element={<AppHomePage />} />
        {/* Link antigo: /app/configuracoes agora é só Empresa/Código de acesso/Modo de atendimento. */}
        <Route path="configuracoes" element={<Navigate to="/app/configuracoes/empresa" replace />} />
        <Route path="configuracoes/empresa" element={<CompanySettingsPage />} />
        <Route path="configuracoes/codigo-acesso" element={<AccessCodeSettingsPage />} />
        <Route path="configuracoes/modo-atendimento" element={<ServiceModeSettingsPage />} />
        <Route path="equipe" element={<TeamPage />} />
        <Route path="comandas" element={<ServicePointsAdminPage />} />

        {/* Placeholders da nova sidebar (ver app/adminNav.ts): módulos ainda não implementados,
            todos com a MESMA página reutilizável — nada de lógica de negócio aqui. */}
        <Route path="financeiro/visao" element={<ModulePlaceholderPage title="Visão financeira" />} />
        <Route path="financeiro/caixa" element={<CashAdmin />} />
        <Route path="financeiro/contas-a-receber" element={<ModulePlaceholderPage title="Contas a receber" />} />
        <Route path="financeiro/contas-a-pagar" element={<ModulePlaceholderPage title="Contas a pagar" />} />
        <Route path="financeiro/relatorios" element={<ReportsRoutePage />} />

        <Route path="cadastros/produtos" element={<ProductsPage />} />
        <Route path="cadastros/categorias" element={<ProductCategoriesPage />} />
        <Route path="cadastros/setores" element={<ProductionSectorsPage />} />
        <Route path="cadastros/estoque" element={<StockPage />} />
        <Route path="cadastros/clientes" element={<ModulePlaceholderPage title="Clientes" />} />

        <Route path="operacional/comandas-abertas" element={<ModulePlaceholderPage title="Comandas / Mesas abertas" />} />
        <Route path="operacional/pedidos" element={<ModulePlaceholderPage title="Pedidos" />} />
        <Route path="operacional/caixa" element={<ModulePlaceholderPage title="Caixa / Balcão" />} />

        <Route path="configuracoes/impressoras" element={<Navigate to="/app/configuracoes/impressao" replace />} />
        <Route path="configuracoes/impressao" element={<PrintingSettingsPage />} />
        <Route path="configuracoes/sistema" element={<ModulePlaceholderPage title="Sistema / Preferências" />} />
      </Route>
      <Route
        path="/master"
        element={
          <MasterRoute>
            <MasterLayout />
          </MasterRoute>
        }
      >
        <Route index element={<MasterOverviewPage />} />
        <Route path="empresas" element={<MasterCompaniesPage />} />
        <Route path="empresas/:id" element={<MasterCompanyDetailPage />} />
        <Route path="faturas" element={<MasterInvoicesPage />} />
        <Route path="faturas/:id" element={<MasterInvoiceDetailPage />} />
        <Route path="planos"element={<MasterPlansPage />} />
        <Route path="modulos" element={<MasterModulesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
