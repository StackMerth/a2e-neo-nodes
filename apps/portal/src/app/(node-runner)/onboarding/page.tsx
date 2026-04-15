'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Check, Copy, Download, Loader2, AlertCircle, ChevronRight, Terminal } from 'lucide-react'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

const steps = [
  { id: 1, title: 'Requirements', description: 'Check system requirements' },
  { id: 2, title: 'Install Agent', description: 'Download and install' },
  { id: 3, title: 'Verify', description: 'Confirm node is online' },
]

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0)

  return (
    <motion.div
      className="max-w-3xl mx-auto space-y-8"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="text-center">
        <h1 className="text-2xl md:text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Set Up Your Node</h1>
        <p style={{ color: 'var(--text-muted)' }}>Follow these steps to get your GPU node earning on the A2E network</p>
      </motion.div>

      {/* Step Indicator */}
      <motion.div variants={item} className="flex items-center justify-center gap-4">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold transition-all"
              style={
                i < currentStep
                  ? { background: 'var(--primary)', color: '#fff' }
                  : i === currentStep
                  ? { background: 'rgba(34,197,94,0.2)', color: 'var(--primary)', border: '2px solid var(--primary)' }
                  : { background: 'var(--bg-card-hover)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
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
      </motion.div>

      {/* Step Content */}
      {currentStep === 0 && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-8"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <h2 className="text-xl font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>System Requirements</h2>
            <div className="space-y-4">
              {[
                { label: 'GPU', detail: 'NVIDIA H100, H200, B200, B300, or GB300', required: true },
                { label: 'NVIDIA Driver', detail: 'Version 535+ with CUDA 12.0+', required: true },
                { label: 'Docker', detail: 'Docker Engine 24+ with NVIDIA Container Toolkit', required: true },
                { label: 'OS', detail: 'Ubuntu 22.04 LTS or later (Linux x64/arm64)', required: true },
                { label: 'Network', detail: 'Stable internet connection with static IP recommended', required: true },
                { label: 'Intel TDX', detail: 'Sapphire Rapids or later CPU (for confidential computing)', required: false },
              ].map(req => (
                <div
                  key={req.label}
                  className="flex items-start gap-3 p-3 rounded-lg"
                  style={{ background: 'var(--bg-card-hover)' }}
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
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setCurrentStep(1)}>
                Continue <ChevronRight size={16} className="ml-1" />
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {currentStep === 1 && (
        <motion.div variants={item}>
          <div
            className="rounded-xl p-8"
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Terminal size={20} style={{ color: 'var(--primary)' }} />
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Install the A2E Agent</h2>
            </div>
            <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>Run this command on your GPU server to install the A2E node agent:</p>

            <div
              className="relative rounded-lg p-4 font-mono text-sm"
              style={{ background: 'var(--bg-darker)', border: '1px solid var(--border-color)' }}
            >
              <code style={{ color: 'var(--primary)' }} className="break-all">
                curl -sSL https://a2e.byredstone.com/v1/releases/install.sh | bash
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(
                    'curl -sSL https://a2e.byredstone.com/v1/releases/install.sh | bash'
                  )
                }}
                className="absolute top-3 right-3 p-1.5 rounded-md transition-colors"
                style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}
                title="Copy to clipboard"
              >
                <Copy size={16} />
              </button>
            </div>

            <div
              className="mt-6 p-4 rounded-lg"
              style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.2)' }}
            >
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--primary)' }}>What this does:</p>
              <ul className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <li>- Downloads the A2E agent binary for your platform</li>
                <li>- Installs it as a systemd service</li>
                <li>- Configures GPU detection and Docker integration</li>
                <li>- Registers your node with the A2E network</li>
              </ul>
            </div>

            <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>Or download manually:</p>
            <div className="flex gap-3 mt-2">
              <Button variant="secondary" size="sm"><Download size={14} className="mr-1" />Linux x64</Button>
              <Button variant="secondary" size="sm"><Download size={14} className="mr-1" />Linux ARM64</Button>
            </div>

            <div className="mt-6 flex justify-between">
              <Button variant="ghost" onClick={() => setCurrentStep(0)}>Back</Button>
              <Button onClick={() => setCurrentStep(2)}>I&apos;ve installed it</Button>
            </div>
          </div>
        </motion.div>
      )}

      {currentStep === 2 && <VerifyStep onBack={() => setCurrentStep(1)} />}
    </motion.div>
  )
}

function VerifyStep({ onBack }: { onBack: () => void }) {
  const [checking, setChecking] = useState(true)
  const [found, setFound] = useState(false)

  useEffect(() => {
    const check = async () => {
      try {
        const data = await nodeRunner.nodes()
        if (data.nodes.length > 0) {
          setFound(true)
          setChecking(false)
        }
      } catch {
        /* ignore */
      }
    }
    check()
    const interval = setInterval(check, 5000)
    const timeout = setTimeout(() => {
      setChecking(false)
    }, 120000)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div
        className="rounded-xl p-8 text-center"
        style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
      >
        {checking && !found ? (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <Loader2 size={32} className="animate-spin" style={{ color: 'var(--primary)' }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Waiting for your node...</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
              We&apos;re checking for your node registration. This usually takes 30-60 seconds after
              installation.
            </p>
          </>
        ) : found ? (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(34,197,94,0.1)' }}
            >
              <Check size={32} style={{ color: 'var(--primary)' }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Node Detected!</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
              Your node is online and registered with the A2E network. You&apos;re now earning.
            </p>
            <Link href="/dashboard">
              <Button>Go to Dashboard</Button>
            </Link>
          </>
        ) : (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'rgba(245,158,11,0.1)' }}
            >
              <AlertCircle size={32} style={{ color: 'var(--warning)' }} />
            </div>
            <h2 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Node not found yet</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
              Make sure the agent is installed and running. Check{' '}
              <code
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ color: 'var(--primary)', background: 'rgba(34,197,94,0.1)' }}
              >
                systemctl status a2e-agent
              </code>{' '}
              on your server.
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                setChecking(true)
                setFound(false)
              }}
            >
              Retry
            </Button>
          </>
        )}
        <div className="mt-4">
          <Button variant="ghost" onClick={onBack}>Back</Button>
        </div>
      </div>
    </motion.div>
  )
}
