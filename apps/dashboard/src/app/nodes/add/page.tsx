'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'

const GPU_TIERS = [
  { value: 'H100', label: 'NVIDIA H100', vram: '80 GB', price: '$140/day' },
  { value: 'H200', label: 'NVIDIA H200', vram: '141 GB', price: '$180/day' },
  { value: 'B200', label: 'NVIDIA B200', vram: '192 GB', price: '$321/day' },
  { value: 'B300', label: 'NVIDIA B300', vram: '288 GB', price: '$432/day' },
  { value: 'GB300', label: 'NVIDIA GB300', vram: '384 GB', price: '$499/day' },
]

const INSTALL_METHODS = [
  {
    id: 'script',
    title: 'One-Line Install',
    description: 'Fastest way to get started. Downloads and configures the agent automatically.',
    icon: TerminalIcon,
    recommended: true,
  },
  {
    id: 'docker',
    title: 'Docker Container',
    description: 'Run the agent as a Docker container. Good for containerized environments.',
    icon: DockerIcon,
  },
  {
    id: 'manual',
    title: 'Manual Installation',
    description: 'Download binary and configure manually. Full control over installation.',
    icon: WrenchIcon,
  },
]

const SYSTEM_REQUIREMENTS = [
  { label: 'Operating System', value: 'Ubuntu 20.04+ or Debian 11+' },
  { label: 'Docker', value: '24.0+ with NVIDIA Container Toolkit' },
  { label: 'NVIDIA Driver', value: '535+ (CUDA 12.2+)' },
  { label: 'GPU', value: 'NVIDIA H100, H200, B200, B300, or GB300' },
  { label: 'Network', value: 'Stable internet connection' },
  { label: 'Storage', value: '50 GB+ free disk space' },
]

export default function AddNodePage() {
  const [step, setStep] = useState(1)
  const [method, setMethod] = useState<string>('')
  const [gpuTier, setGpuTier] = useState('H100')
  const [apiKey, setApiKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [nodeConnected, setNodeConnected] = useState(false)
  const [checkingConnection, setCheckingConnection] = useState(false)

  // Simulated API URL
  const apiUrl = 'https://a2e.byredstone.com'

  const installCommand = method === 'script'
    ? `curl -fsSL ${apiUrl}/install.sh | sudo bash -s -- \\
  --api-url ${apiUrl} \\
  --api-key ${apiKey || '<YOUR_API_KEY>'}`
    : method === 'docker'
    ? `docker run -d \\
  --name a2e-agent \\
  --gpus all \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -e A2E_API_URL=${apiUrl} \\
  -e A2E_API_KEY=${apiKey || '<YOUR_API_KEY>'} \\
  ghcr.io/a2e/node-agent:latest`
    : `# Download binary
curl -LO ${apiUrl}/releases/latest/a2e-agent-linux-x64
chmod +x a2e-agent-linux-x64
sudo mv a2e-agent-linux-x64 /usr/local/bin/a2e-agent

# Configure
sudo a2e-agent configure --output /etc/a2e-agent/agent.yaml

# Start service
sudo systemctl enable --now a2e-agent`

  async function copyToClipboard() {
    await navigator.clipboard.writeText(installCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function checkConnection() {
    setCheckingConnection(true)
    // Simulate checking for new node registration
    await new Promise(resolve => setTimeout(resolve, 3000))
    // In real implementation, poll the API for newly registered nodes
    setCheckingConnection(false)
    // For demo, randomly succeed
    if (Math.random() > 0.5) {
      setNodeConnected(true)
    }
  }

  useEffect(() => {
    if (step === 3 && !nodeConnected) {
      const interval = setInterval(checkConnection, 5000)
      return () => clearInterval(interval)
    }
  }, [step, nodeConnected])

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fadeIn">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/nodes" className="inline-flex items-center gap-1.5 text-text-muted hover:text-accent transition-colors">
          <ArrowLeftIcon className="w-4 h-4" />
          <span>Nodes</span>
        </Link>
        <ChevronRightIcon className="w-4 h-4 text-text-muted" />
        <span className="text-text-primary font-medium">Add Node</span>
      </nav>

      {/* Header */}
      <div className="relative py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent rounded-3xl" />

        <div className="relative text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-accent/5 border border-accent/20 rounded-full mb-6 animate-slideUp">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
            </span>
            <span className="text-xs text-accent font-medium uppercase tracking-wider">Node Onboarding</span>
          </div>

          <h1 className="text-3xl md:text-4xl font-bold text-text-primary mb-3">
            Add a New Node
          </h1>
          <p className="text-text-muted max-w-xl mx-auto">
            Connect your GPU node to the A²E network and start earning.
            Follow the steps below to get your node online.
          </p>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-center gap-4">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`
                w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm
                transition-all duration-300
                ${step === s
                  ? 'bg-accent text-background'
                  : step > s
                    ? 'bg-accent/20 text-accent'
                    : 'bg-surface text-text-muted border border-border'
                }
              `}
            >
              {step > s ? <CheckIcon className="w-4 h-4" /> : s}
            </div>
            <span className={`text-sm ${step >= s ? 'text-text-primary' : 'text-text-muted'}`}>
              {s === 1 ? 'Requirements' : s === 2 ? 'Install' : 'Verify'}
            </span>
            {s < 3 && (
              <div className={`w-12 h-0.5 ${step > s ? 'bg-accent' : 'bg-border'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      {step === 1 && (
        <div className="space-y-6 animate-fadeIn">
          {/* System Requirements */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                <ServerIcon className="w-5 h-5 text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">System Requirements</h3>
                <p className="text-xs text-text-muted">Ensure your system meets these requirements</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SYSTEM_REQUIREMENTS.map((req) => (
                <div key={req.label} className="flex items-start gap-3 p-3 bg-surface/50 rounded-lg border border-border/50">
                  <CheckCircleIcon className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{req.label}</p>
                    <p className="text-xs text-text-muted">{req.value}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* GPU Selection */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-purple to-purple-400 flex items-center justify-center">
                <ChipIcon className="w-5 h-5 text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Select GPU Type</h3>
                <p className="text-xs text-text-muted">Choose the GPU model you're registering</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {GPU_TIERS.map((gpu) => (
                <button
                  key={gpu.value}
                  onClick={() => setGpuTier(gpu.value)}
                  className={`
                    p-4 rounded-xl border text-left transition-all
                    ${gpuTier === gpu.value
                      ? 'bg-accent/10 border-accent/50 ring-1 ring-accent/30'
                      : 'bg-surface/50 border-border/50 hover:border-accent/30'
                    }
                  `}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-text-primary">{gpu.value}</span>
                    {gpuTier === gpu.value && (
                      <CheckCircleIcon className="w-5 h-5 text-accent" />
                    )}
                  </div>
                  <p className="text-xs text-text-muted mb-1">{gpu.vram} VRAM</p>
                  <p className="text-sm text-accent font-medium">{gpu.price}</p>
                </button>
              ))}
            </div>
          </Card>

          {/* Installation Method */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                <DownloadIcon className="w-5 h-5 text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Installation Method</h3>
                <p className="text-xs text-text-muted">Choose how to install the agent</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {INSTALL_METHODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  className={`
                    relative p-4 rounded-xl border text-left transition-all
                    ${method === m.id
                      ? 'bg-accent/10 border-accent/50 ring-1 ring-accent/30'
                      : 'bg-surface/50 border-border/50 hover:border-accent/30'
                    }
                  `}
                >
                  {m.recommended && (
                    <span className="absolute -top-2 -right-2 px-2 py-0.5 bg-accent text-background text-[10px] font-bold rounded-full">
                      RECOMMENDED
                    </span>
                  )}
                  <m.icon className={`w-8 h-8 mb-3 ${method === m.id ? 'text-accent' : 'text-text-muted'}`} />
                  <h4 className="font-medium text-text-primary mb-1">{m.title}</h4>
                  <p className="text-xs text-text-muted">{m.description}</p>
                </button>
              ))}
            </div>
          </Card>

          <div className="flex justify-end">
            <Button
              variant="gradient"
              size="lg"
              onClick={() => setStep(2)}
              disabled={!method}
              icon={<ArrowRightIcon className="w-4 h-4" />}
            >
              Continue to Installation
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6 animate-fadeIn">
          {/* API Key */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-warning to-amber-400 flex items-center justify-center">
                <KeyIcon className="w-5 h-5 text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">API Key</h3>
                <p className="text-xs text-text-muted">Enter your A²E API key for authentication</p>
              </div>
            </div>

            <Input
              label="API Key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="a2e-xxxxxxxx-xxxx-xxxx"
              className="font-mono"
            />

            <p className="mt-2 text-xs text-text-muted">
              Don't have an API key? <Link href="/settings" className="text-accent hover:underline">Generate one in Settings</Link>
            </p>
          </Card>

          {/* Install Command */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                  <TerminalIcon className="w-5 h-5 text-background" />
                </div>
                <div>
                  <h3 className="font-semibold text-text-primary">Installation Command</h3>
                  <p className="text-xs text-text-muted">Run this on your GPU server</p>
                </div>
              </div>

              <Button
                variant="secondary"
                size="sm"
                onClick={copyToClipboard}
                icon={copied ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>

            <pre className="p-4 bg-background rounded-lg border border-border overflow-x-auto">
              <code className="text-sm text-text-primary font-mono whitespace-pre">
                {installCommand}
              </code>
            </pre>

            <div className="mt-4 p-3 bg-accent/5 rounded-lg border border-accent/20">
              <p className="text-xs text-text-muted">
                <span className="text-accent font-medium">Note:</span> The installation script will:
              </p>
              <ul className="mt-2 text-xs text-text-muted space-y-1">
                <li>• Detect your GPU and verify NVIDIA drivers</li>
                <li>• Download the appropriate binary for your system</li>
                <li>• Configure the agent with your API key</li>
                <li>• Install and start the systemd service</li>
              </ul>
            </div>
          </Card>

          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)} icon={<ArrowLeftIcon className="w-4 h-4" />}>
              Back
            </Button>
            <Button
              variant="gradient"
              size="lg"
              onClick={() => setStep(3)}
              disabled={!apiKey}
              icon={<ArrowRightIcon className="w-4 h-4" />}
            >
              I've Run the Command
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-6 animate-fadeIn">
          <Card variant="glass" hover={false}>
            <div className="text-center py-8">
              {nodeConnected ? (
                <>
                  <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-6 animate-pulse">
                    <CheckCircleIcon className="w-10 h-10 text-accent" />
                  </div>
                  <h2 className="text-2xl font-bold text-text-primary mb-2">Node Connected!</h2>
                  <p className="text-text-muted mb-6">
                    Your {gpuTier} node has been successfully registered and is now online.
                  </p>
                  <div className="flex justify-center gap-4">
                    <Link href="/nodes">
                      <Button variant="secondary">View All Nodes</Button>
                    </Link>
                    <Button variant="gradient" onClick={() => {
                      setStep(1)
                      setMethod('')
                      setApiKey('')
                      setNodeConnected(false)
                    }}>
                      Add Another Node
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6">
                    {checkingConnection ? (
                      <LoadingSpinner className="w-10 h-10 text-accent" />
                    ) : (
                      <SearchIcon className="w-10 h-10 text-accent" />
                    )}
                  </div>
                  <h2 className="text-2xl font-bold text-text-primary mb-2">Waiting for Node...</h2>
                  <p className="text-text-muted mb-6 max-w-md mx-auto">
                    We're waiting for your node to connect. This usually takes 1-2 minutes after running the installation command.
                  </p>

                  <div className="flex items-center justify-center gap-2 text-sm text-text-muted mb-6">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                    </span>
                    <span>Checking for connection...</span>
                  </div>

                  <div className="p-4 bg-surface/50 rounded-xl border border-border/50 max-w-md mx-auto text-left">
                    <p className="text-sm font-medium text-text-primary mb-2">Troubleshooting</p>
                    <ul className="text-xs text-text-muted space-y-1">
                      <li>• Verify NVIDIA drivers are installed: <code className="text-accent">nvidia-smi</code></li>
                      <li>• Check Docker is running: <code className="text-accent">docker info</code></li>
                      <li>• View agent logs: <code className="text-accent">sudo journalctl -u a2e-agent</code></li>
                      <li>• Verify network connectivity to API</li>
                    </ul>
                  </div>
                </>
              )}
            </div>
          </Card>

          {!nodeConnected && (
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(2)} icon={<ArrowLeftIcon className="w-4 h-4" />}>
                Back to Installation
              </Button>
              <Button variant="ghost" onClick={checkConnection} loading={checkingConnection}>
                Check Connection
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Icons
function ArrowLeftIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
    </svg>
  )
}

function ArrowRightIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
    </svg>
  )
}

function ChevronRightIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  )
}

function CheckIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function CheckCircleIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ServerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
    </svg>
  )
}

function ChipIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  )
}

function DownloadIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  )
}

function TerminalIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function DockerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M13.98 11.08h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.18.19v1.88c0 .1.08.19.18.19m-2.95-5.43h2.12a.19.19 0 0 0 .18-.19V3.59a.19.19 0 0 0-.18-.19h-2.12a.19.19 0 0 0-.19.19v1.87c0 .11.09.19.19.19m0 2.71h2.12a.19.19 0 0 0 .18-.19V6.29a.19.19 0 0 0-.18-.18h-2.12a.19.19 0 0 0-.19.18v1.88c0 .1.09.19.19.19m-2.93 0h2.12a.19.19 0 0 0 .18-.19V6.29a.19.19 0 0 0-.18-.18H8.1a.19.19 0 0 0-.19.18v1.88c0 .1.08.19.19.19m-2.96 0h2.11a.19.19 0 0 0 .19-.19V6.29a.19.19 0 0 0-.19-.18H5.14a.19.19 0 0 0-.19.18v1.88c0 .1.08.19.19.19m5.89 2.72h2.12a.19.19 0 0 0 .18-.19V9.01a.19.19 0 0 0-.18-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m-2.93 0h2.12a.19.19 0 0 0 .18-.19V9.01a.19.19 0 0 0-.18-.19H8.1a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m-2.96 0h2.11a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H5.14a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m-2.92 0h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H2.22a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m21.54-1.19c-.06-.05-.43-.32-1.27-.32-.22 0-.44.02-.67.06a3.13 3.13 0 0 0-1.59-2.32l-.32-.19-.2.31a3.36 3.36 0 0 0-.48 1.31c-.08.52-.03 1.01.14 1.45-.69.4-1.74.5-2.08.51H.72a.72.72 0 0 0-.72.72 12.07 12.07 0 0 0 .7 4.14 5.86 5.86 0 0 0 2.14 2.79c1.09.74 2.88 1.16 4.91 1.16.91 0 1.84-.08 2.75-.25a11.47 11.47 0 0 0 3.37-1.15c.94-.54 1.78-1.2 2.49-1.93a11.77 11.77 0 0 0 2.18-3.02c.05 0 .1 0 .15-.01.93 0 1.5-.37 1.82-.69.21-.21.39-.46.5-.74l.08-.23-.17-.11z" />
    </svg>
  )
}

function WrenchIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function KeyIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  )
}

function CopyIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  )
}

function SearchIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  )
}

function LoadingSpinner({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
}
