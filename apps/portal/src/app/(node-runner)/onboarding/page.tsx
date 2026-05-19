'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Check, Copy, Loader2, AlertCircle, ChevronRight, Terminal, ListChecks, Cpu, Wallet, Sparkles, Share2 } from 'lucide-react'
import { nodeRunner, byog, auth as authApi } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

const steps = [
  { id: 1, title: 'Requirements', description: 'Check system requirements' },
  { id: 2, title: 'Install Agent', description: 'Download and install' },
  { id: 3, title: 'Verify', description: 'Confirm node is online' },
]

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0)

  return (
    <DashboardShell
      title="Set Up Your Node"
      subtitle="Follow these steps to get your GPU node earning on the TokenOS DeAI network"
    >
      <div className="lg:col-span-3 max-w-3xl mx-auto w-full space-y-6">
        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-4">
          {steps.map((step, i) => (
            <div key={step.id} className="flex items-center gap-3">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold transition-all"
                style={
                  i < currentStep
                    ? { background: 'var(--primary)', color: '#fff' }
                    : i === currentStep
                    ? { background: 'rgba(34,197,94,0.2)', color: 'var(--primary)', border: '2px solid var(--primary)' }
                    : { background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
                }
              >
                {i < currentStep ? <Check size={16} /> : step.id}
              </div>
              <span
                className="text-sm hidden sm:inline"
                style={{ color: i === currentStep ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: i === currentStep ? 500 : 400 }}
              >
                {step.title}
              </span>
              {i < steps.length - 1 && (
                <div
                  className="w-12 h-px"
                  style={{ background: i < currentStep ? 'var(--primary)' : 'var(--border-color)' }}
                />
              )}
            </div>
          ))}
        </div>

        {/* C5: wallet-connect nudge shown above all steps when the user
            signed up with email/password and has no on-chain wallet yet.
            Soft prompt; doesn't block them from continuing. Routes to
            the connect-wallet page with a next= hint so they come back
            here. */}
        {currentStep === 0 && <WalletNudge />}

        {/* Step Content */}
        {currentStep === 0 && (
          <FormCard
            title="System Requirements"
            description="Verify your GPU server meets these baseline specs before installing the agent"
            icon={ListChecks}
            footer={
              <Button onClick={() => setCurrentStep(1)}>
                Continue <ChevronRight size={16} className="ml-1" />
              </Button>
            }
          >
            <FormSection>
              {[
                { label: 'GPU', detail: 'NVIDIA datacenter (H100/H200/B200/B300/GB300) or consumer (RTX 4090/3090, other RTX)', required: true },
                { label: 'NVIDIA Driver', detail: 'Version 535+ with CUDA 12.0+', required: true },
                { label: 'Docker', detail: 'Docker Engine 24+ with NVIDIA Container Toolkit', required: true },
                { label: 'OS', detail: 'Ubuntu 22.04 LTS or later (Linux x64/arm64)', required: true },
                { label: 'Network', detail: 'Stable internet connection. Static IP recommended; home/residential is OK for inference-only workloads.', required: true },
                { label: 'Intel TDX', detail: 'Sapphire Rapids or later CPU (for confidential computing)', required: false },
              ].map(req => (
                <div
                  key={req.label}
                  className="flex items-start gap-3 p-3 rounded-md"
                  style={{ background: 'var(--bg-elevated)' }}
                >
                  <span
                    className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                    style={
                      req.required
                        ? { background: 'rgba(34,197,94,0.2)', color: 'var(--primary)' }
                        : { background: 'rgba(59,130,246,0.2)', color: 'var(--info)' }
                    }
                  >
                    {req.required ? <Check size={12} /> : <AlertCircle size={12} />}
                  </span>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{req.label}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{req.detail}</p>
                  </div>
                  <span
                    className="ml-auto text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap"
                    style={
                      req.required
                        ? { background: 'rgba(34,197,94,0.1)', color: 'var(--primary)' }
                        : { background: 'rgba(59,130,246,0.1)', color: 'var(--info)' }
                    }
                  >
                    {req.required ? 'Required' : 'Optional'}
                  </span>
                </div>
              ))}
            </FormSection>
          </FormCard>
        )}

        {currentStep === 1 && (
          <InstallStep
            onBack={() => setCurrentStep(0)}
            onContinue={() => setCurrentStep(2)}
          />
        )}

        {currentStep === 2 && <VerifyStep onBack={() => setCurrentStep(1)} />}
      </div>
    </DashboardShell>
  )
}

const REGIONS = ['US-WEST', 'US-EAST', 'EU', 'APAC', 'SA', 'OC'] as const
type Region = (typeof REGIONS)[number]

function InstallStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const [region, setRegion] = useState<Region | ''>('')
  const [loading, setLoading] = useState(true)
  const [installCmd, setInstallCmd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function generate(forRegion: Region | '') {
    setLoading(true)
    setError(null)
    try {
      const result = await byog.issueToken(forRegion || undefined)
      setInstallCmd(result.installCommand)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate install command')
    } finally {
      setLoading(false)
    }
  }

  // Mint the token once on mount. Region changes regenerate via the
  // region buttons below; we don't want to thrash tokens on every render.
  useEffect(() => {
    void generate('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onPickRegion(r: Region | '') {
    setRegion(r)
    void generate(r)
  }

  function copy() {
    if (!installCmd) return
    void navigator.clipboard.writeText(installCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <FormCard
      title="Install the TokenOS DeAI Agent"
      description="Run this command on your GPU server to install and register the node agent"
      icon={Terminal}
      footer={
        <div className="flex gap-3 w-full justify-between">
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <Button onClick={onContinue} disabled={!installCmd}>
            I&apos;ve installed it <ChevronRight size={16} className="ml-1" />
          </Button>
        </div>
      }
    >
      <FormSection>
        {/* Region picker. Pre-tagging the token with a region means the
            install script never has to prompt; it just writes the region
            into agent.yaml at registration time. */}
        <div>
          <label className="text-xs uppercase tracking-wider mb-2 block" style={{ color: 'var(--text-muted)' }}>
            Region (optional)
          </label>
          <div className="flex gap-2 flex-wrap mb-2">
            <button
              key="any"
              type="button"
              onClick={() => onPickRegion('')}
              className="px-3 py-1.5 rounded-md text-xs transition-colors"
              style={
                region === ''
                  ? { background: 'var(--primary)', color: '#fff' }
                  : { background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
              }
            >
              Any
            </button>
            {REGIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onPickRegion(r)}
                className="px-3 py-1.5 rounded-md text-xs transition-colors"
                style={
                  region === r
                    ? { background: 'var(--primary)', color: '#fff' }
                    : { background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
                }
              >
                {r}
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Buyers can filter by region. Pick the closest one to your hardware; you can change it later in node settings.
          </p>
        </div>

        {loading ? (
          <div className="rounded-md p-4 flex items-center gap-3" style={{ background: 'var(--bg-elevated)' }}>
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--primary)' }} />
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Generating install command...</span>
          </div>
        ) : error ? (
          <div className="rounded-md p-4" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <p className="text-sm mb-3" style={{ color: 'var(--error)' }}>{error}</p>
            <Button variant="secondary" size="sm" onClick={() => generate(region)}>Try again</Button>
          </div>
        ) : installCmd ? (
          <div
            className="relative rounded-md p-4 font-mono text-sm"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-color)' }}
          >
            <code style={{ color: 'var(--primary)' }} className="break-all pr-12">{installCmd}</code>
            <button
              onClick={copy}
              className="absolute top-3 right-3 p-1.5 rounded-md transition-colors"
              style={{ background: 'var(--bg-card-hover)', color: copied ? 'var(--primary)' : 'var(--text-muted)' }}
              title="Copy to clipboard"
              type="button"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        ) : null}

        <div
          className="p-4 rounded-md"
          style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
        >
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--primary)' }}>What this does:</p>
          <ul className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
            <li>- Downloads the TokenOS DeAI agent binary for your platform</li>
            <li>- Installs it as a systemd service</li>
            <li>- Configures GPU detection and Docker integration</li>
            <li>- Registers your node with the TokenOS DeAI network</li>
            <li>- Auto-starts the agent (first heartbeat within ~30s)</li>
          </ul>
        </div>

        <div
          className="p-4 rounded-md flex items-start gap-3"
          style={{
            background: 'rgba(245,158,11,0.12)',
            border: '1px solid rgba(245,158,11,0.45)',
          }}
        >
          <AlertCircle
            size={20}
            style={{ color: 'var(--warning, #f59e0b)', flexShrink: 0, marginTop: 1 }}
          />
          <p
            className="text-sm font-semibold leading-relaxed"
            style={{ color: 'var(--warning, #f59e0b)' }}
          >
            The install token is single-use and expires in 7 days. Each token
            claims exactly one machine; mint a new one for each additional node.
          </p>
        </div>
      </FormSection>
    </FormCard>
  )
}

const VERIFY_TIMEOUT_SEC = 90
const VERIFY_POLL_SEC = 5

function VerifyStep({ onBack }: { onBack: () => void }) {
  const [checking, setChecking] = useState(true)
  const [found, setFound] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)

  const runCheck = async () => {
    try {
      const data = await nodeRunner.nodes()
      if (data.nodes.length > 0) {
        setFound(true)
        setChecking(false)
        return true
      }
    } catch {
      /* network errors retry on next tick */
    }
    return false
  }

  useEffect(() => {
    if (!checking) return
    void runCheck()
    const tick = setInterval(() => {
      setElapsedSec((s) => s + 1)
    }, 1000)
    const poll = setInterval(() => {
      void runCheck()
    }, VERIFY_POLL_SEC * 1000)
    const timeout = setTimeout(() => {
      setChecking(false)
    }, VERIFY_TIMEOUT_SEC * 1000)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
      clearTimeout(timeout)
    }
  }, [checking])

  const remainingSec = Math.max(0, VERIFY_TIMEOUT_SEC - elapsedSec)

  return (
    <FormCard
      title="Verify your node"
      description="We are checking the network for your node registration"
      icon={Cpu}
      footer={
        <Button variant="ghost" onClick={onBack}>Back</Button>
      }
    >
      <FormSection>
        {checking && !found ? (
          <div className="text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <Loader2 size={32} className="animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Waiting for your node...</h2>
            <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
              We&apos;re checking for your node registration. This usually takes 30-60 seconds after installation completes.
            </p>
            <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
              Elapsed: {elapsedSec}s &middot; Will stop checking in {remainingSec}s
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                void runCheck()
              }}
            >
              Check now
            </Button>
          </div>
        ) : found ? (
          <CelebrationCard />
        ) : (
          <div className="text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(245,158,11,0.1)' }}
            >
              <AlertCircle size={32} style={{ color: 'var(--warning)' }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Node not detected</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
              We waited {VERIFY_TIMEOUT_SEC} seconds and did not see a node register. Common causes:
            </p>
            <ul
              className="text-xs text-left mx-auto mb-6 space-y-1.5 max-w-md"
              style={{ color: 'var(--text-muted)' }}
            >
              <li>&bull; The install command was not run on your GPU server yet.</li>
              <li>&bull; The agent installed but is not running. On the server, check{' '}
                <code
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ color: 'var(--primary)', background: 'rgba(34,197,94,0.1)' }}
                >
                  systemctl status a2e-agent
                </code>.
              </li>
              <li>&bull; The server cannot reach the TokenOS DeAI API (firewall blocking outbound HTTPS).</li>
            </ul>
            <Button
              variant="secondary"
              onClick={() => {
                setChecking(true)
                setFound(false)
                setElapsedSec(0)
              }}
            >
              Try again
            </Button>
          </div>
        )}
      </FormSection>
    </FormCard>
  )
}

// C5 wave 1: shown on step 1 (Requirements) when the operator signed
// up via email/password and hasn't set a payout wallet yet. Points
// at /payouts/settings (the real "set my payout wallet" page) rather
// than /connect-wallet — the latter is wallet-auth-only and bounces
// authenticated users to /dashboard, which would be a broken trip.
function WalletNudge() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let cancelled = false
    authApi
      .me()
      .then((me) => {
        if (cancelled) return
        if (!me.walletAddress) setShow(true)
      })
      .catch(() => { /* quiet */ })
    return () => { cancelled = true }
  }, [])
  if (!show) return null
  return (
    <div
      className="rounded-lg p-4 flex items-start gap-3"
      style={{
        background: 'rgba(59,130,246,0.06)',
        border: '1px solid rgba(59,130,246,0.25)',
      }}
    >
      <Wallet size={18} style={{ color: 'var(--info, #3b82f6)', flexShrink: 0, marginTop: 2 }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Tip: set your payout wallet first
        </p>
        <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Earnings route to the Solana wallet on your operator profile.
          Set it now and skip the swap later.
        </p>
      </div>
      <Link href="/payouts/settings">
        <Button variant="secondary" size="sm">
          Set wallet
        </Button>
      </Link>
    </div>
  )
}

// C5 wave 1: post-verify celebration card. Replaces the silent "Node
// Detected!" copy with an activation moment: animated checkmark + sparkles,
// "you're earning" copy, and three next-step CTAs. Wallet CTA only renders
// when the operator signed up by email and hasn't connected a payout wallet
// yet — gives them the obvious next step without forcing it.
function CelebrationCard() {
  const [walletPrompt, setWalletPrompt] = useState(false)
  useEffect(() => {
    let cancelled = false
    authApi
      .me()
      .then((me) => {
        if (cancelled) return
        // Show wallet nudge only if the user has no on-chain wallet on
        // their User row. NodeRunner has its own walletAddress (used
        // by payout routing) but the User row reflects the actual
        // signed-in identity wallet, which is what we want here.
        if (!me.walletAddress) setWalletPrompt(true)
      })
      .catch(() => { /* quiet */ })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="text-center relative overflow-hidden">
      {/* Animated radial sparkle burst. Pure CSS so we don't pull in a
          confetti library for a single-shot celebration. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at 50% 30%, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0) 60%)',
          animation: 'a2e-pulse 2.4s ease-out',
        }}
      />
      <style jsx>{`
        @keyframes a2e-pulse {
          0% { opacity: 0; transform: scale(0.6); }
          40% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.4); }
        }
        @keyframes a2e-pop {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>

      <div className="relative">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5"
          style={{
            background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.4)',
            animation: 'a2e-pop 0.55s cubic-bezier(.22,1,.36,1)',
          }}
        >
          <Check size={36} style={{ color: 'var(--primary)' }} />
        </div>

        <div className="inline-flex items-center gap-2 mb-2 px-3 py-1 rounded-full" style={{
          background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)'
        }}>
          <Sparkles size={12} style={{ color: 'var(--primary)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--primary)' }}>
            First heartbeat received
          </span>
        </div>

        <h2 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          You&apos;re earning.
        </h2>
        <p className="text-sm mb-6 max-w-md mx-auto" style={{ color: 'var(--text-muted)' }}>
          Your node is online and registered with the TokenOS DeAI network.
          Earnings start accruing the moment a buyer rents your GPU.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
          <Link href="/dashboard">
            <Button>
              <Cpu size={14} className="mr-1.5" />
              Go to Dashboard
            </Button>
          </Link>
          {walletPrompt && (
            <Link href="/payouts/settings">
              <Button variant="secondary">
                <Wallet size={14} className="mr-1.5" />
                Set Payout Wallet
              </Button>
            </Link>
          )}
        </div>

        {/* Compact next-steps list — three highest-value follow-ups
            without being pushy. Each is one line + a small icon. */}
        <div
          className="rounded-lg p-4 max-w-md mx-auto text-left"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-color)',
          }}
        >
          <p className="text-xs font-mono uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--text-muted)' }}>
            Next steps
          </p>
          <ul className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <li className="flex items-start gap-2">
              <ChevronRight size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--primary)' }} />
              <span>Install the agent on more machines for more capacity.</span>
            </li>
            <li className="flex items-start gap-2">
              <Share2 size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--primary)' }} />
              <span>Share your <Link href="/referral" className="underline">referral code</Link> — earn 10% of referee earnings for 365 days.</span>
            </li>
            <li className="flex items-start gap-2">
              <Wallet size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--primary)' }} />
              <span>Configure <Link href="/payouts/settings" className="underline">payout settings</Link> when you&rsquo;re ready to withdraw.</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
