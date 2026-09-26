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
import { OnboardingPage } from "./pages/OnboardingPage";
import { OperationalCashierPage, OperationalServicePage } from "./pages/OperationalPages";
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
        path="/operacional/caixa"
        element={
          <OperationalRoute area="caixa">
            <OperationalCashierPage />
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
        <Route path="configuracoes" element={<CompanySettingsPage />} />
        <Route path="equipe" element={<TeamPage />} />
        <Route path="comandas" element={<ServicePointsAdminPage />} />
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
