import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App.jsx'
import Chat from './pages/Chat.jsx'
import Connection from './pages/Connection.jsx'
import Configuration from './pages/Configuration.jsx'
import Prompt from './pages/Prompt.jsx'
import faviconUrl from './images/favicon-48x48.png'
import './index.scss'

const favicon = document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = faviconUrl
document.head.appendChild(favicon)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/connection" element={<Connection />} />
          <Route path="/configuration" element={<Configuration />} />
          <Route path="/prompt" element={<Prompt />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
