'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { nodeRunner } from '@/lib/api'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

const steps = [
  { id: 1, title: 'Requirements', description: 'Check system requirements' },
  { id: 2, title: 'Install Agent', description: 'Download and install' },
  { id: 3, title: 'Verify', description: 'Confirm node is online' },
]

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(0)

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-fadeIn">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-2xl md:text-3xl font-bold text-text-primary mb-2">Set Up Your Node</h1>
        <p className="text-text-muted">Follow these steps to get your GPU node earning on the A2E network</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-center gap-4">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-center gap-3">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold transition-all ${
                i < currentStep
                  ? 'bg-accent text-white'
                  : i === currentStep
                  ? 'bg-accent/20 text-accent border-2 border-accent'
                  : 'bg-surface-hover text-text-muted border border-border'
              }`}
            >
              {i < currentStep ? '\u2713' : step.id}
            </div>
            <span
              className={`text-sm hidden sm:inline ${
                i === currentStep ? 'text-text-primary font-medium' : 'text-text-muted'
              }`}
            >
              {step.title}
            </span>
            {i < steps.length - 1 && (
              <div className={`w-12 h-px ${i < currentStep ? 'bg-accent' : 'bg-border'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      {currentStep === 0 && (
        <Card className="p-8 animate-slideUp">
          <h2 className="text-xl font-semibold text-text-primary mb-4">System Requirements</h2>
          <div className="space-y-4">
            {[
              { label: 'GPU', detail: 'NVIDIA H100, H200, B200, B300, or GB300', required: true },
              { label: 'NVIDIA Driver', detail: 'Version 535+ with CUDA 12.0+', required: true },
              { label: 'Docker', detail: 'Docker Engine 24+ with NVIDIA Container Toolkit', required: true },
              { label: 'OS', detail: 'Ubuntu 22.04 LTS or later (Linux x64/arm64)', required: true },
              { label: 'Network', detail: 'Stable internet connection with static IP recommended', required: true },
              { label: 'Intel TDX', detail: 'Sapphire Rapids or later CPU (for confidential computing)', required: false },
            ].map(req => (
              <div key={req.label} className="flex items-start gap-3 p-3 bg-surface-hover rounded-lg">
                <span
                  className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                    req.required ? 'bg-accent/20 text-accent' : 'bg-accent-blue/20 text-accent-blue'
                  }`}
                >
                  {req.required ? '\u2713' : '?'}
                </span>
                <div>
                  <p className="text-sm font-medium text-text-primary">{req.label}</p>
                  <p className="text-xs text-text-muted">{req.detail}</p>
                </div>
                <span
                  className={`ml-auto text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${
                    req.required ? 'bg-accent/10 text-accent' : 'bg-accent-blue/10 text-accent-blue'
                  }`}
                >
                  {req.required ? 'Required' : 'Optional'}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setCurrentStep(1)}>Continue</Button>
          </div>
        </Card>
      )}

      {currentStep === 1 && (
        <Card className="p-8 animate-slideUp">
          <h2 className="text-xl font-semibold text-text-primary mb-4">Install the A2E Agent</h2>
          <p className="text-text-secondary mb-6">Run this command on your GPU server to install the A2E node agent:</p>

          <div className="relative bg-[#0d0d0d] border border-border rounded-lg p-4 font-mono text-sm">
            <code className="text-accent break-all">
              curl -sSL https://a2e.byredstone.com/v1/releases/install.sh | bash
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(
                  'curl -sSL https://a2e.byredstone.com/v1/releases/install.sh | bash'
                )
              }}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-surface-hover hover:bg-border transition-colors text-text-muted hover:text-text-primary"
              title="Copy to clipboard"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          </div>

          <div className="mt-6 p-4 bg-accent/5 border border-accent/20 rounded-lg">
            <p className="text-sm text-accent font-medium mb-1">What this does:</p>
            <ul className="text-xs text-text-secondary space-y-1">
              <li>- Downloads the A2E agent binary for your platform</li>
              <li>- Installs it as a systemd service</li>
              <li>- Configures GPU detection and Docker integration</li>
              <li>- Registers your node with the A2E network</li>
            </ul>
          </div>

          <p className="text-xs text-text-muted mt-4">Or download manually:</p>
          <div className="flex gap-3 mt-2">
            <Button variant="secondary" size="sm">Linux x64</Button>
            <Button variant="secondary" size="sm">Linux ARM64</Button>
          </div>

          <div className="mt-6 flex justify-between">
            <Button variant="ghost" onClick={() => setCurrentStep(0)}>Back</Button>
            <Button onClick={() => setCurrentStep(2)}>I&apos;ve installed it</Button>
          </div>
        </Card>
      )}

      {currentStep === 2 && <VerifyStep onBack={() => setCurrentStep(1)} />}
    </div>
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
    <Card className="p-8 animate-slideUp text-center">
      {checking && !found ? (
        <>
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">Waiting for your node...</h2>
          <p className="text-text-muted text-sm mb-6">
            We&apos;re checking for your node registration. This usually takes 30-60 seconds after
            installation.
          </p>
        </>
      ) : found ? (
        <>
          <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">Node Detected!</h2>
          <p className="text-text-muted text-sm mb-6">
            Your node is online and registered with the A2E network. You&apos;re now earning.
          </p>
          <Link href="/dashboard">
            <Button>Go to Dashboard</Button>
          </Link>
        </>
      ) : (
        <>
          <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">Node not found yet</h2>
          <p className="text-text-muted text-sm mb-6">
            Make sure the agent is installed and running. Check{' '}
            <code className="text-accent text-xs bg-accent/10 px-1.5 py-0.5 rounded">
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
    </Card>
  )
}
