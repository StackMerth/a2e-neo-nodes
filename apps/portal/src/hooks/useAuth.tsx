'use client'

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { auth as authApi, setTokens, clearTokens } from '@/lib/api'

interface User {
  id: string
  email: string | null
  walletAddress: string | null
  role: string
  // Dual-identity flags surfaced by /v1/portal/auth/me. The UI uses
  // these to decide whether to show the role-aware intro callout
  // when a user lands on the "other" side. May be undefined on
  // legacy clients hitting an older token; treat as primary-role
  // matches the flag.
  isBuyer?: boolean
  isNodeRunner?: boolean
  isAdmin?: boolean
  nodeRunnerId: string | null
  // Email verification state. The auto-send fires on signup; the
  // dashboard banner reads this flag to decide whether to show the
  // 'verify your email' nudge + resend button. Undefined on legacy
  // tokens; treat as 'unknown — assume unverified to be safe' in
  // gating UI (banner shows; sensitive actions block).
  emailVerified?: boolean
}

interface AuthContextType {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<User>
  register: (email: string, password: string, role?: 'NODE_RUNNER' | 'COMPUTE_BUYER', referralCode?: string) => Promise<User>
  walletLogin: (
    address: string,
    signature: string,
    nonce: string,
    role?: 'NODE_RUNNER' | 'COMPUTE_BUYER'
  ) => Promise<User>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const loadUser = useCallback(async () => {
    try {
      const token = localStorage.getItem('a2e_access_token')
      if (!token) {
        setLoading(false)
        return
      }
      const data = await authApi.me()
      setUser(data as User)
    } catch {
      clearTokens()
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  const login = async (email: string, password: string): Promise<User> => {
    const data = await authApi.login(email, password)
    setTokens(data.accessToken, data.refreshToken)
    const u = data.user as User
    setUser(u)
    return u
  }

  const register = async (
    email: string,
    password: string,
    role?: 'NODE_RUNNER' | 'COMPUTE_BUYER',
    referralCode?: string,
  ): Promise<User> => {
    const data = await authApi.register(email, password, role, referralCode)
    setTokens(data.accessToken, data.refreshToken)
    const u = data.user as User
    setUser(u)
    return u
  }

  const walletLogin = async (
    address: string,
    signature: string,
    nonce: string,
    role?: 'NODE_RUNNER' | 'COMPUTE_BUYER'
  ): Promise<User> => {
    const data = await authApi.walletAuth(address, signature, nonce, role)
    setTokens(data.accessToken, data.refreshToken)
    const u = data.user as User
    setUser(u)
    return u
  }

  const logout = async () => {
    const refreshToken = localStorage.getItem('a2e_refresh_token')
    if (refreshToken) {
      try { await authApi.logout(refreshToken) } catch { /* ignore */ }
    }
    clearTokens()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, walletLogin, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
