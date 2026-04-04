import http from 'node:http'
import { HttpAgent } from '@ag-ui/client'
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime'

const port = Number(process.env.COPILOTKIT_RUNTIME_PORT ?? 8787)
const host = process.env.COPILOTKIT_RUNTIME_HOST ?? '127.0.0.1'
const endpoint = process.env.COPILOTKIT_RUNTIME_ENDPOINT ?? '/api/copilotkit'
const strandsAgentUrl = process.env.STRANDS_AGENT_URL ?? 'http://127.0.0.1:8000'

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

function requestOrigin(req) {
  const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${port}`
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  const protoHeader = req.headers['x-forwarded-proto'] ?? 'http'
  const protoValue = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader
  return `${protoValue}://${hostValue}`
}

function requestHeaders(req) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
      continue
    }
    headers.set(key, value)
  }
  return headers
}

function sendWebResponse(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()

  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        res.end()
        return
      }
      res.write(Buffer.from(value))
    }
  }

  pump().catch((error) => {
    console.error('[copilot-runtime] failed to stream response', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'Runtime streaming error' }))
  })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

async function dispatchCompatRequest(req, res, method, params = {}, body) {
  const headers = requestHeaders(req)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')

  const compatRequest = new Request(`${requestOrigin(req)}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      method,
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    }),
  })

  const response = await handleCopilotRequest(compatRequest)
  sendWebResponse(res, response)
}

const server = http.createServer(async (req, res) => {
  const requestUrl = req.url ?? '/'
  const url = new URL(requestUrl, requestOrigin(req))
  const pathname = url.pathname

  if (pathname === '/health' || pathname === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      endpoint,
      strandsAgentUrl,
    }))
    return
  }

  if (pathname === endpoint || pathname === `${endpoint}/`) {
    await handleCopilotRequest(req, res)
    return
  }

  if (pathname === `${endpoint}/info`) {
    await dispatchCompatRequest(req, res, 'info')
    return
  }

  const agentRoute = pathname.match(
    new RegExp(`^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/agent/([^/]+)/(connect|run|stop)$`)
  )

  if (agentRoute) {
    const [, agentId, action] = agentRoute
    const parsedBody = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)

    if (action === 'connect') {
      await dispatchCompatRequest(req, res, 'agent/connect', { agentId }, parsedBody)
      return
    }

    if (action === 'run') {
      await dispatchCompatRequest(req, res, 'agent/run', { agentId }, parsedBody)
      return
    }

    if (action === 'stop') {
      const threadId = parsedBody?.threadId ?? url.searchParams.get('threadId')
      await dispatchCompatRequest(req, res, 'agent/stop', { agentId, threadId })
      return
    }
  }

  if (pathname.startsWith(endpoint)) {
    await handleCopilotRequest(req, res)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    error: 'Not found',
    endpoint,
  }))
})

server.listen(port, host, () => {
  console.log(`[copilot-runtime] listening on http://${host}:${port}${endpoint}`)
  console.log(`[copilot-runtime] proxying agent ${strandsAgentUrl}`)
})
