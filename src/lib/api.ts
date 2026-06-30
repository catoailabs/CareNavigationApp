import { getIdToken } from '@/stores/authStore'

/**
 * fetch wrapper that attaches the Firebase ID token as an Authorization bearer
 * header so the backend can verify identity and resolve the per-user Google
 * credentials. Falls back to a plain request when no token is available (local
 * dev bypass).
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken()
  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

/**
 * Return headers (including Authorization when available) for use with APIs that
 * accept a static header map, such as the AI SDK chat transport.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
