import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Desktop (Tauri): `vite build --mode desktop` gera apps/web/dist-desktop SEM service worker/PWA — o frontend vai
// empacotado no instalador e quem atualiza é o updater do Tauri. O build normal (PWA/Vercel) não muda.
export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop'
  return {
  build: desktop ? { outDir: 'dist-desktop' } : undefined,
  plugins: [
    react(),
    ...(desktop ? [] : [VitePWA({
      // atualização automática: o novo service worker assume assim que instalado
      registerType: 'autoUpdate',
      manifest: {
        name: 'Gestão Atendimento Pro',
        short_name: 'Gestão Atendimento',
        description: 'Gestão Atendimento Pro: comandas, mesas, pedidos e caixa para a sua empresa.',
        lang: 'pt-BR',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f7f6f9',
        theme_color: '#863bff',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // só o shell estático (js/css/html/ícones) é pré-cacheado; nenhuma
        // chamada ao Supabase (REST/Auth/Storage/Functions) passa pelo cache
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/storage\//, /^\/functions\//],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [],
        // handlers de push/notificationclick (public/push-sw.js) dentro do service worker gerado: importScripts é
        // a forma de estender o generateSW sem trocar de estratégia
        importScripts: ['push-sw.js'],
      },
    })]),
  ],
  // lê o .env da raiz do monorepo em vez de apps/web, para não duplicar o arquivo
  envDir: '../../',
}
})
