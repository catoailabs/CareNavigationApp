import { create } from 'zustand'
import {
  onAuthStateChanged,
  type User,
} from 'firebase/auth'
import { AUTH_DISABLED, getAuthClient } from '@/lib/firebase'

export type AuthUser = {
  id: string
  email: string | null
  displayName: string | null
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

type AuthStore = {
  user: AuthUser | null
  status: AuthStatus
}

function toAuthUser(user: User): AuthUser {
  return { id: user.uid, email: user.email, displayName: user.displayName }
}

export const useAuthStore = create<AuthStore>(() => {
  // Local-dev bypass: mirrors backend FIREBASE_AUTH_DISABLED.
  if (AUTH_DISABLED || !getAuthClient()) {
    return {
      user: { id: 'dev-user', email: null, displayName: 'Developer' },
      status: 'authenticated' as AuthStatus,
    }
  }
  return { user: null, status: 'loading' as AuthStatus }
})

// Subscribe to Firebase auth state (no-op in dev bypass mode).
const client = getAuthClient()
if (client && !AUTH_DISABLED) {
  onAuthStateChanged(client, (user) => {
    useAuthStore.setState(
      user
        ? { user: toAuthUser(user), status: 'authenticated' }
        : { user: null, status: 'unauthenticated' },
    )
  })
}

/**
 * Return the current Firebase ID token, or null when unauthenticated / in the
 * local dev bypass. Used to attach Authorization headers to backend calls.
 */
export async function getIdToken(): Promise<string | null> {
  const auth = getAuthClient()
  if (!auth || AUTH_DISABLED) return null
  const current = auth.currentUser
  if (!current) return null
  try {
    return await current.getIdToken()
  } catch {
    return null
  }
}
