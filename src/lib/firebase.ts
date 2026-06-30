/**
 * Firebase client initialization.
 *
 * Configuration is supplied via Vite env vars (never committed):
 *   VITE_FIREBASE_API_KEY
 *   VITE_FIREBASE_AUTH_DOMAIN
 *   VITE_FIREBASE_PROJECT_ID
 *   VITE_FIREBASE_STORAGE_BUCKET
 *   VITE_FIREBASE_MESSAGING_SENDER_ID
 *   VITE_FIREBASE_APP_ID
 *
 * Set VITE_AUTH_DISABLED=true to run the app locally without Firebase (mirrors
 * the backend FIREBASE_AUTH_DISABLED bypass). In that mode `getAuthClient()`
 * returns null and the auth store falls back to a dev user.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
  type Auth,
} from 'firebase/auth'

export const AUTH_DISABLED = import.meta.env.VITE_AUTH_DISABLED === 'true'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
}

let app: FirebaseApp | null = null
let auth: Auth | null = null

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId)
}

export function getAuthClient(): Auth | null {
  if (AUTH_DISABLED) return null
  if (!isFirebaseConfigured()) return null
  if (!auth) {
    app = app ?? initializeApp(firebaseConfig)
    auth = getAuth(app)
  }
  return auth
}

export const googleProvider = new GoogleAuthProvider()
