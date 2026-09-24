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
import { MasterOverviewPage } from "./pages/MasterOverviewPage";
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
