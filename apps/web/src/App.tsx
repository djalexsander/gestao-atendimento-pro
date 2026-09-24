import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./app/AppLayout";
import { MasterLayout } from "./app/MasterLayout";
import {
  AppRoute,
  GuestOnlyRoute,
  MasterRoute,
  OnboardingRoute,
  RootRedirect,
} from "./app/routeGuards";
import { AppHomePage } from "./pages/AppHomePage";
import { CompanySettingsPage } from "./pages/CompanySettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { MasterCompaniesPage } from "./pages/MasterCompaniesPage";
import { MasterCompanyDetailPage } from "./pages/MasterCompanyDetailPage";
import { MasterInvoiceDetailPage } from "./pages/MasterInvoiceDetailPage";
import { MasterInvoicesPage } from "./pages/MasterInvoicesPage";
import { MasterModulesPage } from "./pages/MasterModulesPage";
import { MasterOverviewPage } from "./pages/MasterOverviewPage";
import { MasterPlansPage } from "./pages/MasterPlansPage";
import { OnboardingPage } from "./pages/OnboardingPage";
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
        path="/onboarding"
        element={
          <OnboardingRoute>
            <OnboardingPage />
          </OnboardingRoute>
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
