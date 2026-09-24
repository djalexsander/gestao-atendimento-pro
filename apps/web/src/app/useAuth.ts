import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./authContext";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa ser usado dentro de <AuthProvider>.");
  return ctx;
}
