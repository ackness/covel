import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './components/game/AutoGuideRenderer.css'
import './blockRenderers' // Register all block renderers
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
