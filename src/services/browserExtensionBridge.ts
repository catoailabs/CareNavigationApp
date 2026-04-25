import type { ContextItem } from '@/components/agent-panel/ContextPicker'

const PAGE_SOURCE = 'provider-tab-bridge-page'
const EXTENSION_SOURCE = 'provider-tab-bridge-extension'

type BridgeRequestType = 'PING' | 'GET_TABS'

interface BridgeRequestEnvelope {
  requestId: string
  source: typeof PAGE_SOURCE
  type: BridgeRequestType
}

interface BridgeResponseEnvelope<TPayload = unknown> {
  error?: string
  ok: boolean
  payload?: TPayload
  requestId: string
  source: typeof EXTENSION_SOURCE
}

function createRequestId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isBridgeResponse<TPayload>(
  value: unknown,
  requestId: string,
): value is BridgeResponseEnvelope<TPayload> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as BridgeResponseEnvelope).source === EXTENSION_SOURCE &&
      (value as BridgeResponseEnvelope).requestId === requestId,
  )
}

function requestBridge<TPayload>(
  type: BridgeRequestType,
  timeoutMs: number,
): Promise<TPayload> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Browser extension bridge requires a window context.'))
  }

  const requestId = createRequestId()

  return new Promise<TPayload>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Browser extension bridge timed out.'))
    }, timeoutMs)

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window) return
      if (!isBridgeResponse<TPayload>(event.data, requestId)) return

      cleanup()

      if (!event.data.ok) {
        reject(new Error(event.data.error || 'Browser extension bridge request failed.'))
        return
      }

      resolve(event.data.payload as TPayload)
    }

    const cleanup = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', handleMessage)
    }

    window.addEventListener('message', handleMessage)

    const request: BridgeRequestEnvelope = {
      requestId,
      source: PAGE_SOURCE,
      type,
    }

    window.postMessage(request, window.location.origin)
  })
}

export async function isBrowserExtensionBridgeAvailable(): Promise<boolean> {
  try {
    await requestBridge<{ version: number }>('PING', 1200)
    return true
  } catch {
    return false
  }
}

export async function loadTabsFromBrowserExtension(): Promise<ContextItem[]> {
  return requestBridge<ContextItem[]>('GET_TABS', 20000)
}
