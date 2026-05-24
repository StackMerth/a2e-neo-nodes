'use client'

/**
 * Connect Wallet button for the TopHeader. When no wallet is
 * connected it opens the wallet-adapter modal. When a wallet IS
 * connected, the button renders as a compact pill showing the
 * shortened address with a chevron menu (disconnect / copy address).
 *
 * Sits between the BalanceIndicator and the ConnectionStatusIndicator
 * in the right-side cluster. Hidden on the smallest screens to keep
 * the header uncluttered — wallet flows on mobile happen via the
 * inline forms anyway.
 */

import { useState, useRef, useEffect } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Wallet as WalletIcon, ChevronDown, Copy, Check, LogOut } from 'lucide-react'

export function ConnectWalletButton() {
  const { publicKey, disconnect, wallet, connecting } = useWallet()
  const { setVisible } = useWalletModal()
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  if (!publicKey) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        disabled={connecting}
        className="hidden md:inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border transition-all hover:opacity-90 shrink-0 disabled:opacity-60"
        style={{ background: 'var(--bg-elevated)' }}
        title="Connect a Solana wallet"
      >
        <WalletIcon size={14} style={{ color: 'var(--primary)' }} />
        <span className="font-mono text-xs uppercase tracking-[0.12em]" style={{ color: 'var(--text-primary)' }}>
          {connecting ? 'Connecting…' : 'Connect Wallet'}
        </span>
      </button>
    )
  }

  const addr = publicKey.toBase58()
  const short = `${addr.slice(0, 4)}…${addr.slice(-4)}`

  async function copyAddress() {
    await navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="relative shrink-0 hidden md:inline-block" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        className="inline-flex items-center gap-2 h-9 px-3 rounded-md border transition-all hover:opacity-90"
        style={{
          background: 'rgba(34,197,94,0.08)',
          borderColor: 'rgba(34,197,94,0.35)',
          color: 'var(--text-primary)',
        }}
        title={`${wallet?.adapter.name ?? 'Wallet'}: ${addr}`}
      >
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: 'var(--primary)' }}
        />
        <span className="font-mono text-xs">{short}</span>
        <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 top-full mt-2 w-56 rounded-lg overflow-hidden z-50"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 12px 32px -8px rgba(0,0,0,0.4)',
          }}
        >
          <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-color)' }}>
            <div className="text-[10px] uppercase tracking-[0.16em] font-mono mb-1" style={{ color: 'var(--text-muted)' }}>
              Connected wallet
            </div>
            <div className="text-xs font-mono break-all" style={{ color: 'var(--text-primary)' }}>
              {addr}
            </div>
            {wallet?.adapter.name && (
              <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                via {wallet.adapter.name}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={copyAddress}
            className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-white/5 transition-colors text-left"
            style={{ color: 'var(--text-secondary)' }}
          >
            {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button
            type="button"
            onClick={() => {
              void disconnect()
              setMenuOpen(false)
            }}
            className="w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-white/5 transition-colors text-left"
            style={{ color: 'var(--text-secondary)' }}
          >
            <LogOut size={14} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}
