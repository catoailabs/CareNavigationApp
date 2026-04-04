import { CopilotKitProvider } from '@copilotkit/react-core/v2'
import { BuildWorkbenchPage } from './components/build/BuildWorkbenchPage'
import { ProviderToolRenderers } from './copilot/provider/ProviderToolRenderers'
import { COPILOT_RUNTIME_PATH } from './copilot/provider/constants'
import { useStrandsToolRenderers } from './components/ai-elements/strands-tool-renderers'

function StrandsIntegration() {
  useStrandsToolRenderers()
  return null
}

function App() {
  return (
    <CopilotKitProvider runtimeUrl={COPILOT_RUNTIME_PATH}>
      <ProviderToolRenderers />
      <StrandsIntegration />
      <BuildWorkbenchPage />
    </CopilotKitProvider>
  )
}

export default App
