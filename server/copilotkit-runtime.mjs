import http from 'node:http'
import { HttpAgent } from '@ag-ui/client'
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime'

const port = Number(process.env.COPILOTKIT_RUNTIME_PORT ?? 8787)
const endpoint = process.env.COPILOTKIT_RUNTIME_ENDPOINT ?? '/api/copilotkit'
const strandsAgentUrl = process.env.STRANDS_AGENT_URL ?? 'http://localhost:8000'

const runtime = new CopilotRuntime({
  agents: {
    provider_research_agent: new HttpAgent({
      url: strandsAgentUrl,
    }),
  },
})

const handleCopilotRequest = copilotRuntimeNodeHttpEndpoint({
  runtime,
  serviceAdapter: new ExperimentalEmptyAdapter(),
  endpoint,
})

const server = http.createServer(async (req, res) => {
  const requestUrl = req.url ?? '/'

  if (requestUrl === '/health' || requestUrl === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      endpoint,
      strandsAgentUrl,
    }))
    return
  }

  if (requestUrl.startsWith(endpoint)) {
    await handleCopilotRequest(req, res)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    error: 'Not found',
    endpoint,
  }))
})

server.listen(port, () => {
  console.log(`[copilot-runtime] listening on http://localhost:${port}${endpoint}`)
  console.log(`[copilot-runtime] proxying agent ${strandsAgentUrl}`)
})
