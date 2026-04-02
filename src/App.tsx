import { CopilotKitProvider } from '@copilotkit/react-core/v2'
import { BuildWorkbenchPage } from './components/build/BuildWorkbenchPage'
import { ProviderToolRenderers } from './copilot/provider/ProviderToolRenderers'
import { COPILOT_RUNTIME_PATH } from './copilot/provider/constants'

function App() {
  return (
    <CopilotKitProvider runtimeUrl={COPILOT_RUNTIME_PATH}>
      <ProviderToolRenderers />
      <BuildWorkbenchPage />
    </CopilotKitProvider>
  )
}

export default App
