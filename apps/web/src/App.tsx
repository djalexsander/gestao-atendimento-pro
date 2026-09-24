import { Navigate, Route, Routes } from "react-router-dom";
import { AppRoute, GuestOnlyRoute, OnboardingRoute, RootRedirect } from "./app/routeGuards";
import { AppHomePage } from "./pages/AppHomePage";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SignupPage } from "./pages/SignupPage";

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
            <AppHomePage />
          </AppRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
