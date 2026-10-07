import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './app/AuthProvider'
import { CommercialProvider } from './features/commercial/CommercialProvider'
import { PwaUpdateProvider } from './features/pwa/PwaUpdateProvider'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <PwaUpdateProvider>
        <AuthProvider>
          <CommercialProvider>
            <App />
          </CommercialProvider>
        </AuthProvider>
      </PwaUpdateProvider>
    </BrowserRouter>
  </StrictMode>,
)
