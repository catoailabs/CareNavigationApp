/**
 * Google Identity Services (GIS) authorization code flow helper.
 *
 * Loads the GIS client script on demand and requests an authorization code
 * (ux_mode: 'popup') with offline access so the backend can obtain a refresh
 * token. The code is exchanged server-side at POST /api/google/connect.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'

type CodeResponse = {
  code?: string
  scope?: string
  error?: string
  error_description?: string
}

type CodeClient = {
  requestCode: () => void
}

type GoogleOAuth2 = {
  initCodeClient: (config: {
    client_id: string
    scope: string
    ux_mode: 'popup' | 'redirect'
    access_type?: 'offline' | 'online'
    prompt?: string
    callback: (response: CodeResponse) => void
    error_callback?: (error: { type?: string; message?: string }) => void
  }) => CodeClient
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth2
      }
    }
  }
}

let scriptPromise: Promise<void> | null = null

function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')))
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

export function getGoogleOAuthClientId(): string {
  return (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined) ?? ''
}

/**
 * Open the Google consent popup and resolve with the authorization code and the
 * scopes Google actually granted. Requests offline access + forced consent so a
 * refresh token is reliably returned.
 */
export async function requestGoogleAuthCode(
  scopes: string[],
): Promise<{ code: string; scope: string }> {
  const clientId = getGoogleOAuthClientId()
  if (!clientId) {
    throw new Error('VITE_GOOGLE_OAUTH_CLIENT_ID is not configured.')
  }
  await loadGisScript()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) {
    throw new Error('Google Identity Services failed to initialize.')
  }

  return new Promise<{ code: string; scope: string }>((resolve, reject) => {
    const client = oauth2.initCodeClient({
      client_id: clientId,
      scope: scopes.join(' '),
      ux_mode: 'popup',
      access_type: 'offline',
      prompt: 'consent',
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error))
          return
        }
        if (!response.code) {
          reject(new Error('Google did not return an authorization code.'))
          return
        }
        resolve({ code: response.code, scope: response.scope ?? scopes.join(' ') })
      },
      error_callback: (error) => {
        reject(new Error(error.message || error.type || 'Google sign-in failed.'))
      },
    })
    client.requestCode()
  })
}
