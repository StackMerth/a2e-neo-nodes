'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, ChevronRight, Check, CheckCircle,
  AlertCircle, X, Settings, Server, Terminal, ClipboardList,
  Cpu, Key, Tag, Rocket, Copy, Loader2, FlaskConical, Plus,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

const GPU_TIERS = [
  { value: 'H100', label: 'NVIDIA H100', vram: '80 GB', price: '$140/day' },
  { value: 'H200', label: 'NVIDIA H200', vram: '141 GB', price: '$180/day' },
  { value: 'B200', label: 'NVIDIA B200', vram: '192 GB', price: '$321/day' },
  { value: 'B300', label: 'NVIDIA B300', vram: '288 GB', price: '$432/day' },
  { value: 'GB300', label: 'NVIDIA GB300', vram: '384 GB', price: '$499/day' },
  { value: 'OTHER', label: 'Other GPU', vram: 'Custom', price: 'Custom' },
]

const SYSTEM_REQUIREMENTS = [
  { label: 'Operating System', value: 'Ubuntu 20.04+ or Debian 11+' },
  { label: 'Docker', value: '24.0+ with NVIDIA Container Toolkit' },
  { label: 'NVIDIA Driver', value: '535+ (CUDA 12.2+)' },
  { label: 'GPU', value: 'NVIDIA H100, H200, B200, B300, or GB300' },
  { label: 'Network', value: 'Stable internet connection' },
  { label: 'Storage', value: '50 GB+ free disk space' },
]

interface ProvisionLog {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

interface ProvisionStatus {
  provisionId: string
  status: string
  currentStep: number
  totalSteps: number
  currentAction: string
  logs: ProvisionLog[]
  node?: { id: string }
  error?: string
}

export default function AddNodePage() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [method, setMethod] = useState<'ssh' | 'manual'>('ssh')

  // SSH Provisioning fields
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [authMethod, setAuthMethod] = useState<'password' | 'privateKey'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  // Node config
  const [gpuTier, setGpuTier] = useState('H100')
  const [nodeName, setNodeName] = useState('')
  const [region, setRegion] = useState('')

  // Custom GPU fields (for OTHER tier)
  const [customGpuModel, setCustomGpuModel] = useState('')
  const [customRatePerDay, setCustomRatePerDay] = useState('')

  // Test mode (no GPU required)
  const [testMode, setTestMode] = useState(false)

  // Provisioning state
  const [provisionId, setProvisionId] = useState<string | null>(null)
  const [provisionStatus, setProvisionStatus] = useState<ProvisionStatus | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Manual install
  const [copied, setCopied] = useState(false)
  const apiUrl = 'https://a2e.byredstone.com'
  const [apiKey] = useState(() => `a2e-demo-${Math.random().toString(36).slice(2, 10)}`)

  const installCommand = `curl -fsSL ${apiUrl}/install.sh | sudo bash -s -- \\
  --api-url ${apiUrl} \\
  --api-key ${apiKey}`

  // Poll for provision status
  const pollStatus = useCallback(async () => {
    if (!provisionId) return

    try {
      const status = await api.provision.getStatus(provisionId)
      setProvisionStatus(status)

      if (status.status === 'COMPLETED') {
        setProvisioning(false)
      } else if (status.status === 'FAILED') {
        setProvisioning(false)
        setError(status.error || 'Provisioning failed')
      } else if (status.status !== 'CANCELLED') {
        // Keep polling
        setTimeout(pollStatus, 2000)
      }
    } catch (err) {
      console.error('Failed to poll status:', err)
    }
  }, [provisionId])

  useEffect(() => {
    if (provisionId && provisioning) {
      pollStatus()
    }
  }, [provisionId, provisioning, pollStatus])

  async function startProvisioning() {
    setError(null)
    setProvisioning(true)

    try {
      const response = await api.provision.start({
        host,
        port: parseInt(port),
        username,
        authMethod,
        password: authMethod === 'password' ? password : undefined,
        privateKey: authMethod === 'privateKey' ? privateKey : undefined,
        passphrase: authMethod === 'privateKey' && passphrase ? passphrase : undefined,
        gpuTier,
        nodeName: nodeName || undefined,
        region: region || undefined,
        customGpuModel: gpuTier === 'OTHER' ? customGpuModel : undefined,
        customRatePerDay: gpuTier === 'OTHER' && customRatePerDay ? parseFloat(customRatePerDay) : undefined,
        testMode: testMode || undefined,
      })

      setProvisionId(response.provisionId)
      setStep(3)
    } catch (err) {
      setProvisioning(false)
      setError(err instanceof Error ? err.message : 'Failed to start provisioning')
    }
  }

  async function copyToClipboard() {
    await navigator.clipboard.writeText(installCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const canStartProvisioning = host && username && (
    (authMethod === 'password' && password) ||
    (authMethod === 'privateKey' && privateKey)
  )

  const getStepLabel = (status: string) => {
    switch (status) {
      case 'CONNECTING': return 'Connecting'
      case 'VERIFYING': return 'Verifying'
      case 'DOWNLOADING': return 'Downloading'
      case 'INSTALLING': return 'Installing'
      case 'CONFIGURING': return 'Configuring'
      case 'STARTING': return 'Starting'
      case 'WAITING_REGISTRATION': return 'Registering'
      case 'COMPLETED': return 'Complete'
      case 'FAILED': return 'Failed'
      default: return 'Pending'
    }
  }

  return (
    <motion.div className="max-w-4xl mx-auto space-y-8" variants={container} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={item}>
        <Link href="/nodes" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-accent transition-colors mb-4">
          <ArrowLeft size={16} />
          Back to Nodes
        </Link>
        <div className="dash-header">
          <div className="dash-header-left">
            <h1><Plus size={28} /> Add New Node</h1>
          </div>
        </div>
      </motion.div>

      {/* Progress Steps */}
      <div className="flex items-center gap-4">
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
              {step > s ? <Check size={16} /> : s}
            </div>
            <span className={`text-sm ${step >= s ? 'text-text-primary' : 'text-text-muted'}`}>
              {s === 1 ? 'Configure' : s === 2 ? 'Connect' : 'Provision'}
            </span>
            {s < 3 && (
              <div className={`w-12 h-0.5 ${step > s ? 'bg-accent' : 'bg-border'}`} />
            )}
          </div>
        ))}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-xl flex items-center gap-3 animate-slideUp">
          <div className="w-8 h-8 rounded-lg bg-error/20 flex items-center justify-center shrink-0">
            <AlertCircle size={16} className="text-error" />
          </div>
          <p className="text-error text-sm flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-error/60 hover:text-error">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Step 1: Configure */}
      {step === 1 && (
        <div className="space-y-6 animate-fadeIn">
          {/* Installation Method Selection */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                <Settings size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Installation Method</h3>
                <p className="text-xs text-text-muted">Choose how to add your node</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                onClick={() => setMethod('ssh')}
                className={`
                  relative p-4 rounded-xl border text-left transition-all
                  ${method === 'ssh'
                    ? 'bg-accent/10 border-accent/50 ring-1 ring-accent/30'
                    : 'bg-surface/50 border-border/50 hover:border-accent/30'
                  }
                `}
              >
                <span className="absolute -top-2 -right-2 px-2 py-0.5 bg-accent text-background text-[10px] font-bold rounded-full">
                  RECOMMENDED
                </span>
                <Server className={`w-8 h-8 mb-3 ${method === 'ssh' ? 'text-accent' : 'text-text-muted'}`} />
                <h4 className="font-medium text-text-primary mb-1">SSH Provisioning</h4>
                <p className="text-xs text-text-muted">
                  Enter SSH credentials and we'll install everything automatically.
                </p>
              </button>

              <button
                onClick={() => setMethod('manual')}
                className={`
                  p-4 rounded-xl border text-left transition-all
                  ${method === 'manual'
                    ? 'bg-accent/10 border-accent/50 ring-1 ring-accent/30'
                    : 'bg-surface/50 border-border/50 hover:border-accent/30'
                  }
                `}
              >
                <Terminal className={`w-8 h-8 mb-3 ${method === 'manual' ? 'text-accent' : 'text-text-muted'}`} />
                <h4 className="font-medium text-text-primary mb-1">Manual Installation</h4>
                <p className="text-xs text-text-muted">
                  Run the install command yourself on your server.
                </p>
              </button>
            </div>
          </Card>

          {/* System Requirements */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                <ClipboardList size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">System Requirements</h3>
                <p className="text-xs text-text-muted">Your server must meet these requirements</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {SYSTEM_REQUIREMENTS.map((req) => (
                <div key={req.label} className="flex items-start gap-3 p-3 bg-surface/50 rounded-lg border border-border/50">
                  <CheckCircle size={20} className="text-accent shrink-0 mt-0.5" />
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
                <Cpu size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">GPU Type</h3>
                <p className="text-xs text-text-muted">Select your GPU model</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {GPU_TIERS.map((gpu) => (
                <button
                  key={gpu.value}
                  onClick={() => setGpuTier(gpu.value)}
                  className={`
                    p-3 rounded-xl border text-center transition-all
                    ${gpuTier === gpu.value
                      ? 'bg-accent/10 border-accent/50 ring-1 ring-accent/30'
                      : 'bg-surface/50 border-border/50 hover:border-accent/30'
                    }
                  `}
                >
                  <span className="font-semibold text-text-primary text-sm">{gpu.value === 'OTHER' ? 'Other' : gpu.value}</span>
                  <p className="text-xs text-text-muted">{gpu.vram}</p>
                  <p className="text-xs text-accent font-medium">{gpu.price}</p>
                </button>
              ))}
            </div>

            {/* Custom GPU fields for OTHER tier */}
            {gpuTier === 'OTHER' && (
              <div className="mt-4 p-4 bg-surface/50 rounded-xl border border-border/50">
                <p className="text-sm text-text-muted mb-4">
                  Specify your GPU model and custom pricing for this node.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="GPU Model"
                    value={customGpuModel}
                    onChange={(e) => setCustomGpuModel(e.target.value)}
                    placeholder="e.g., A100, RTX 4090, L40S"
                  />
                  <Input
                    label="Daily Rate (USD)"
                    type="number"
                    value={customRatePerDay}
                    onChange={(e) => setCustomRatePerDay(e.target.value)}
                    placeholder="e.g., 50.00"
                  />
                </div>
              </div>
            )}
          </Card>

          {/* Test Mode Option */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-warning to-amber-400 flex items-center justify-center">
                <FlaskConical size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Test Mode</h3>
                <p className="text-xs text-text-muted">For testing on servers without a real GPU</p>
              </div>
            </div>

            <label className="flex items-start gap-3 p-4 bg-surface/50 rounded-xl border border-border/50 cursor-pointer hover:border-accent/30 transition-colors">
              <input
                type="checkbox"
                checked={testMode}
                onChange={(e) => setTestMode(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent"
              />
              <div className="flex-1">
                <span className="text-sm font-medium text-text-primary">Enable Test Mode (No GPU Required)</span>
                <p className="text-xs text-text-muted mt-1">
                  Skip GPU verification and use mock GPU metrics. The node will appear online but won't process real jobs. Useful for testing agent connectivity and dashboard integration.
                </p>
              </div>
            </label>

            {testMode && (
              <div className="mt-3 p-3 bg-warning/10 rounded-lg border border-warning/20">
                <p className="text-xs text-warning">
                  <span className="font-semibold">Note:</span> Test mode nodes cannot accept production workloads. Use only for development and testing purposes.
                </p>
              </div>
            )}
          </Card>

          <div className="flex justify-end">
            <Button
              variant="gradient"
              size="lg"
              onClick={() => setStep(2)}
              icon={<ArrowRight size={16} />}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Connect (SSH) or Install (Manual) */}
      {step === 2 && method === 'ssh' && (
        <div className="space-y-6 animate-fadeIn">
          {/* SSH Credentials */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-warning to-amber-400 flex items-center justify-center">
                <Key size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">SSH Connection</h3>
                <p className="text-xs text-text-muted">Enter your server's SSH credentials</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Host / IP Address"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100 or server.example.com"
              />
              <Input
                label="SSH Port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
              />
              <Input
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="root"
              />
              <Select
                label="Authentication Method"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as 'password' | 'privateKey')}
                options={[
                  { value: 'password', label: 'Password' },
                  { value: 'privateKey', label: 'SSH Private Key' },
                ]}
              />
            </div>

            {authMethod === 'password' && (
              <div className="mt-4">
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter SSH password"
                />
              </div>
            )}

            {authMethod === 'privateKey' && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-2">
                    Private Key
                  </label>
                  <textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                    className="w-full h-32 px-4 py-3 bg-background border border-border rounded-lg text-text-primary font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent/50"
                  />
                </div>
                <Input
                  label="Passphrase (if key is encrypted)"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            )}

            <div className="mt-4 p-3 bg-accent/5 rounded-lg border border-accent/20">
              <p className="text-xs text-text-muted">
                <span className="text-accent font-medium">Security Note:</span> Your credentials are used only during provisioning and are not stored. They are transmitted securely and discarded after installation completes.
              </p>
            </div>
          </Card>

          {/* Node Configuration */}
          <Card variant="glass" hover={false}>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-blue to-blue-400 flex items-center justify-center">
                <Tag size={20} className="text-background" />
              </div>
              <div>
                <h3 className="font-semibold text-text-primary">Node Configuration</h3>
                <p className="text-xs text-text-muted">Optional settings for your node</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Node Name (optional)"
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="gpu-node-01"
              />
              <Input
                label="Region (optional)"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1"
              />
            </div>
          </Card>

          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)} icon={<ArrowLeft size={16} />}>
              Back
            </Button>
            <Button
              variant="gradient"
              size="lg"
              onClick={startProvisioning}
              disabled={!canStartProvisioning}
              loading={provisioning}
              icon={<Rocket size={16} />}
            >
              Start Provisioning
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Manual Install */}
      {step === 2 && method === 'manual' && (
        <div className="space-y-6 animate-fadeIn">
          <Card variant="glass" hover={false}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-emerald-400 flex items-center justify-center">
                  <Terminal size={20} className="text-background" />
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
                icon={copied ? <Check size={16} /> : <Copy size={16} />}
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
                <span className="text-accent font-medium">What this does:</span>
              </p>
              <ul className="mt-2 text-xs text-text-muted space-y-1">
                <li>1. Detects your GPU and verifies NVIDIA drivers</li>
                <li>2. Downloads the A²E agent binary</li>
                <li>3. Configures the agent with your API key</li>
                <li>4. Installs and starts the systemd service</li>
              </ul>
            </div>
          </Card>

          <div className="flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)} icon={<ArrowLeft size={16} />}>
              Back
            </Button>
            <Button
              variant="gradient"
              size="lg"
              onClick={() => router.push('/nodes')}
              icon={<Check size={16} />}
            >
              I've Run the Command
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Provisioning Progress */}
      {step === 3 && (
        <div className="space-y-6 animate-fadeIn">
          <Card variant="glass" hover={false}>
            {provisionStatus?.status === 'COMPLETED' ? (
              <div className="text-center py-8">
                <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-6">
                  <CheckCircle size={40} className="text-accent" />
                </div>
                <h2 className="text-2xl font-bold text-text-primary mb-2">Node Provisioned!</h2>
                <p className="text-text-muted mb-6">
                  Your {gpuTier} node has been successfully installed and is now online.
                </p>
                <div className="flex justify-center gap-4">
                  <Link href="/nodes">
                    <Button variant="secondary">View All Nodes</Button>
                  </Link>
                  {provisionStatus.node && (
                    <Link href={`/nodes/${provisionStatus.node.id}`}>
                      <Button variant="gradient">View Node Details</Button>
                    </Link>
                  )}
                </div>
              </div>
            ) : provisionStatus?.status === 'FAILED' ? (
              <div className="text-center py-8">
                <div className="w-20 h-20 rounded-full bg-error/20 flex items-center justify-center mx-auto mb-6">
                  <AlertCircle size={40} className="text-error" />
                </div>
                <h2 className="text-2xl font-bold text-text-primary mb-2">Provisioning Failed</h2>
                <p className="text-error mb-6">{provisionStatus.error}</p>
                <div className="flex justify-center gap-4">
                  <Button variant="secondary" onClick={() => { setStep(2); setProvisionId(null); setProvisionStatus(null); }}>
                    Try Again
                  </Button>
                  <Button variant="ghost" onClick={() => setMethod('manual')}>
                    Use Manual Install
                  </Button>
                </div>
              </div>
            ) : (
              <div className="py-8">
                <div className="text-center mb-8">
                  <div className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6">
                    <Loader2 size={40} className="text-accent animate-spin" />
                  </div>
                  <h2 className="text-2xl font-bold text-text-primary mb-2">
                    {provisionStatus?.currentAction || 'Starting...'}
                  </h2>
                  <p className="text-text-muted">
                    Step {provisionStatus?.currentStep || 0} of {provisionStatus?.totalSteps || 7}
                  </p>
                </div>

                {/* Progress Bar */}
                <div className="mb-6">
                  <div className="flex justify-between text-xs text-text-muted mb-2">
                    <span>{getStepLabel(provisionStatus?.status || 'PENDING')}</span>
                    <span>{Math.round(((provisionStatus?.currentStep || 0) / 7) * 100)}%</span>
                  </div>
                  <div className="h-2 bg-surface rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-accent to-emerald-400 transition-all duration-500"
                      style={{ width: `${((provisionStatus?.currentStep || 0) / 7) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Logs */}
                {provisionStatus?.logs && provisionStatus.logs.length > 0 && (
                  <div className="bg-background rounded-lg border border-border p-4 max-h-64 overflow-y-auto font-mono text-xs">
                    {(provisionStatus.logs as ProvisionLog[]).map((log, i) => (
                      <div key={i} className={`mb-1 ${
                        log.level === 'error' ? 'text-error' :
                        log.level === 'warn' ? 'text-warning' : 'text-text-muted'
                      }`}>
                        <span className="text-text-muted/50">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                        {log.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          {provisionStatus?.status !== 'COMPLETED' && provisionStatus?.status !== 'FAILED' && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                onClick={() => {
                  // Cancel provisioning
                  if (provisionId) {
                    api.provision.cancel(provisionId).catch(console.error)
                  }
                  setStep(2)
                  setProvisionId(null)
                  setProvisionStatus(null)
                  setProvisioning(false)
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}

// All SVG icon functions removed - using lucide-react imports
function _legacyArrowRightIcon({ className = 'w-4 h-4' }: { className?: string }) {
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

function AlertIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function CloseIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function SettingsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
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

function TerminalIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function ChecklistIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
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

function KeyIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  )
}

function TagIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
    </svg>
  )
}

function RocketIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
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

function LoadingSpinner({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
}

function BeakerIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    </svg>
  )
}
