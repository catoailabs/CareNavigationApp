import { useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth'
import { useAuthStore } from '@/stores/authStore'
import { getAuthClient, googleProvider, isFirebaseConfigured, AUTH_DISABLED } from '@/lib/firebase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/utils/cn'

function friendlyError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: string }).code)
    if (code.includes('invalid-credential') || code.includes('wrong-password')) {
      return 'Incorrect email or password.'
    }
    if (code.includes('email-already-in-use')) return 'That email is already registered.'
    if (code.includes('weak-password')) return 'Password should be at least 6 characters.'
    if (code.includes('invalid-email')) return 'Enter a valid email address.'
    if (code.includes('popup-closed-by-user')) return 'Sign-in was cancelled.'
  }
  return err instanceof Error ? err.message : 'Authentication failed.'
}

function LoginScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const configured = isFirebaseConfigured()

  const handleEmailAuth = async () => {
    const auth = getAuthClient()
    if (!auth) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleGoogle = async () => {
    const auth = getAuthClient()
    if (!auth) return
    setBusy(true)
    setError(null)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-surface-950 px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.14),transparent_58%)]" />
      <div className="relative w-full max-w-md rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(10,10,18,0.92),rgba(5,5,10,0.94))] p-8 shadow-[0_32px_120px_-48px_rgba(99,102,241,0.4)]">
        <div className="text-center">
          <img src="/Logo.png" alt="Ron" className="mx-auto h-8 w-auto" />
          <h1 className="mt-6 text-2xl font-light text-white">
            {mode === 'signup' ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-sm text-white/55">
            Sign in to access provider research and your connected Google tools.
          </p>
        </div>

        {!configured ? (
          <div className="mt-6 rounded-xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Firebase is not configured. Set the <code>VITE_FIREBASE_*</code> env vars, or set{' '}
            <code>VITE_AUTH_DISABLED=true</code> for local development.
          </div>
        ) : (
          <>
            <div className="mt-7 space-y-4">
              <div className="space-y-2">
                <label htmlFor="auth-email" className="text-xs text-white/60">Email</label>
                <Input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-11 border-white/[0.08] bg-white/[0.04] text-white placeholder:text-white/25"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="auth-password" className="text-xs text-white/60">Password</label>
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleEmailAuth()
                  }}
                  placeholder="••••••••"
                  className="h-11 border-white/[0.08] bg-white/[0.04] text-white placeholder:text-white/25"
                />
              </div>
            </div>

            {error ? <p className="mt-4 text-sm text-rose-300">{error}</p> : null}

            <Button
              onClick={() => void handleEmailAuth()}
              disabled={busy || !email.trim() || !password}
              className="mt-6 h-11 w-full bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40"
            >
              {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
            </Button>

            <div className="my-5 flex items-center gap-3 text-xs text-white/35">
              <div className="h-px flex-1 bg-white/[0.08]" />
              or
              <div className="h-px flex-1 bg-white/[0.08]" />
            </div>

            <Button
              variant="outline"
              onClick={() => void handleGoogle()}
              disabled={busy}
              className="h-11 w-full border-white/[0.12] bg-white/[0.04] text-white hover:bg-white/[0.08]"
            >
              Continue with Google
            </Button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signup' ? 'signin' : 'signup')
                setError(null)
              }}
              className={cn('mt-6 w-full text-center text-sm text-white/55 hover:text-white')}
            >
              {mode === 'signup'
                ? 'Already have an account? Sign in'
                : "Don't have an account? Create one"}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Gates the application behind Firebase authentication. Renders a loading state
 * while auth resolves, the login screen when unauthenticated, and children once
 * authenticated. The local dev bypass (VITE_AUTH_DISABLED) reports authenticated
 * immediately.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status)

  if (AUTH_DISABLED) return <>{children}</>

  if (status === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-950">
        <div className="text-sm text-white/55">Loading…</div>
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <LoginScreen />
  }

  return <>{children}</>
}
