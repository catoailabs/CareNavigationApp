import type { ContextItem } from '@/components/agent-panel/ContextPicker'
import {
  isBrowserExtensionBridgeAvailable,
  loadTabsFromBrowserExtension,
} from '@/services/browserExtensionBridge'

// ─────────────────────────────────────────────────────────────────────────────
// Chrome DevTools Protocol Tab Service
// ─────────────────────────────────────────────────────────────────────────────
// Fetches real browser tab data from Chrome's DevTools Protocol endpoint.
// Requires Chrome to be started with: --remote-debugging-port=9222
// The Vite dev server proxies /api/chrome-tabs → http://localhost:9222/json

export interface ChromeTab {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
  devtoolsFrontendUrl?: string
  faviconUrl?: string
  description?: string
}

interface ExtractedTabContext {
  pageContent?: string
  navigationInfo?: ContextItem['navigationInfo']
}

// Fetch all open Chrome tabs via CDP
async function fetchChromeTabs(): Promise<ChromeTab[]> {
  try {
    const res = await fetch('/api/chrome-tabs', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) throw new Error(`CDP returned ${res.status}`)
    const tabs: ChromeTab[] = await res.json()
    // Only return actual pages (not background, service workers, etc.)
    return tabs.filter(t => t.type === 'page')
  } catch {
    return []
  }
}

// Capture a screenshot of a specific tab via CDP WebSocket
async function captureTabScreenshot(tab: ChromeTab): Promise<string | null> {
  if (!tab.webSocketDebuggerUrl) return null

  try {
    // Rewrite the WebSocket URL to go through our proxy
    const wsUrl = tab.webSocketDebuggerUrl
      .replace('ws://localhost:9222', `ws://${window.location.host}/api/chrome-ws`)

    return new Promise<string | null>((resolve) => {
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve(null)
      }, 5000)

      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Page.captureScreenshot',
          params: { format: 'jpeg', quality: 40 }
        }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id === 1 && msg.result?.data) {
            resolve(`data:image/jpeg;base64,${msg.result.data}`)
          } else {
            resolve(null)
          }
        } catch {
          resolve(null)
        }
        clearTimeout(timeout)
        ws.close()
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

// Get full tab context via CDP
async function getTabContext(tab: ChromeTab): Promise<ExtractedTabContext | null> {
  if (!tab.webSocketDebuggerUrl) return null

  try {
    const wsUrl = tab.webSocketDebuggerUrl
      .replace('ws://localhost:9222', `ws://${window.location.host}/api/chrome-ws`)

    return new Promise<ExtractedTabContext | null>((resolve) => {
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve(null)
      }, 5000)

      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const canonical = document.querySelector('link[rel="canonical"]')?.href || undefined
              const referrer = document.referrer || undefined
              const links = Array.from(
                new Set(
                  Array.from(document.querySelectorAll('a[href]'))
                    .map((anchor) => anchor.href)
                    .filter(Boolean)
                )
              )

              return {
                pageContent: (document.documentElement?.innerText || document.body?.innerText || '').trim(),
                navigationInfo: {
                  canonical,
                  referrer,
                  links,
                },
              }
            })()`,
            returnByValue: true,
          },
        }))
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id === 1 && msg.result?.result?.value) {
            resolve(msg.result.result.value as ExtractedTabContext)
          } else {
            resolve(null)
          }
        } catch {
          resolve(null)
        }
        clearTimeout(timeout)
        ws.close()
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

// Build a favicon URL from a page URL
function getFaviconUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl)
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`
  } catch {
    return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export async function loadRealTabs(): Promise<ContextItem[]> {
  try {
    return await loadTabsFromBrowserExtension()
  } catch {
    // Fall back to the local CDP bridge when the extension bridge is unavailable.
  }

  const chromeTabs = await fetchChromeTabs()

  if (chromeTabs.length === 0) {
    // CDP not available — return empty array, caller should fall back to SAMPLE_TABS
    return []
  }

  // Build enriched context items from real tabs
  const items: ContextItem[] = await Promise.all(
    chromeTabs.map(async (tab): Promise<ContextItem> => {
      const item: ContextItem = {
        id: tab.id,
        type: 'tab',
        name: tab.title || tab.url || 'New Tab',
        description: tab.url,
        url: tab.url,
        title: tab.title,
        favicon: tab.faviconUrl || getFaviconUrl(tab.url),
      }

      // Attempt screenshot capture
      try {
        const screenshot = await captureTabScreenshot(tab)
        if (screenshot) item.screenshotUrl = screenshot
      } catch { /* graceful fallback */ }

      // Attempt page content extraction
      try {
        const tabContext = await getTabContext(tab)
        if (tabContext?.pageContent) {
          item.pageContent = tabContext.pageContent
        }
        if (tabContext?.navigationInfo) {
          item.navigationInfo = tabContext.navigationInfo
        }
      } catch { /* graceful fallback */ }

      return item
    })
  )

  return items
}

// Check if CDP is available (Chrome launched with --remote-debugging-port)
export async function isCDPAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/chrome-tabs', { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export async function isAnyTabBridgeAvailable(): Promise<boolean> {
  const [extensionAvailable, cdpAvailable] = await Promise.all([
    isBrowserExtensionBridgeAvailable(),
    isCDPAvailable(),
  ])

  return extensionAvailable || cdpAvailable
}
