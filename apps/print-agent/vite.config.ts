import { defineConfig } from "vite";

// Lê o .env da raiz do monorepo (mesmo padrão do apps/web). Só variáveis VITE_* chegam ao bundle:
// URL e chave PÚBLICA (anon) do Supabase. Nenhum segredo de servidor existe neste app.
export default defineConfig({
  envDir: "../../",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
});
