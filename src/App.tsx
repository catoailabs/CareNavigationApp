import { BuildWorkbenchPage } from './components/build/BuildWorkbenchPage'
import { AuthGate } from './components/auth/AuthGate'

function App() {
  return (
    <AuthGate>
      <BuildWorkbenchPage />
    </AuthGate>
  )
}

export default App
