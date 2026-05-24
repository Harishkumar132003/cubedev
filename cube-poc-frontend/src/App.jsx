import { Outlet } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import './App.scss'

function App() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  )
}

export default App
