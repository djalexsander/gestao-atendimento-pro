import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // lê o .env da raiz do monorepo em vez de apps/web, para não duplicar o arquivo
  envDir: '../../',
})
