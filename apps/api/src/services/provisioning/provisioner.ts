import { PrismaClient, ProvisionStatus, GpuTier } from '@a2e/database'
import { SSHClient, SSHCredentials } from './ssh-client'
import { EventEmitter } from 'events'
import crypto from 'crypto'

export interface ProvisionConfig {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  gpuTier: GpuTier
  nodeName?: string
  region?: string
  // Custom GPU fields for OTHER tier
  customGpuModel?: string
  customRatePerDay?: number
  // Test mode - skip GPU verification and use mock GPU
  testMode?: boolean
}

export interface ProvisionLog {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

const PROVISION_STEPS = [
  { status: 'CONNECTING', action: 'Connecting to server' },
  { status: 'VERIFYING', action: 'Verifying prerequisites' },
  { status: 'DOWNLOADING', action: 'Downloading agent binary' },
  { status: 'INSTALLING', action: 'Installing agent' },
  { status: 'CONFIGURING', action: 'Configuring agent' },
  { status: 'STARTING', action: 'Starting agent service' },
  { status: 'WAITING_REGISTRATION', action: 'Waiting for node registration' },
] as const

export class NodeProvisioner extends EventEmitter {
  private prisma: PrismaClient
  private sshClient: SSHClient | null = null
  private provisionId: string
  private logs: ProvisionLog[] = []
  private apiUrl: string
  private apiKey: string
  private sudo: string = 'sudo ' // Will be empty string if running as root

  constructor(prisma: PrismaClient, provisionId: string, apiKey: string) {
    super()
    this.prisma = prisma
    this.provisionId = provisionId
    this.apiUrl = process.env.A2E_API_URL || 'https://a2e-api.onrender.com'
    this.apiKey = apiKey
  }

  private async detectRootUser(): Promise<void> {
    if (!this.sshClient) return
    const result = await this.sshClient.exec('id -u')
    if (result.code === 0 && result.stdout.trim() === '0') {
      this.sudo = '' // Running as root, no sudo needed
      await this.log('info', 'Running as root user, sudo not required')
    } else {
      this.sudo = 'sudo '
      await this.log('info', 'Running as non-root user, will use sudo')
    }
  }

  private async log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    const entry: ProvisionLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
    }
    this.logs.push(entry)
    this.emit('log', entry)

    // Persist logs to database
    await this.prisma.provisionJob.update({
      where: { id: this.provisionId },
      data: { logs: this.logs as unknown as string },
    })
  }

  private async updateStatus(
    status: ProvisionStatus,
    step: number,
    action: string
  ): Promise<void> {
    await this.prisma.provisionJob.update({
      where: { id: this.provisionId },
      data: {
        status,
        currentStep: step,
        currentAction: action,
        startedAt: step === 1 ? new Date() : undefined,
      },
    })
    this.emit('status', { status, step, action })
  }

  /**
   * Poll the ProvisionJob row to see if an admin cancelled this run.
   * Called between SSH steps. Throwing here is caught by the outer
   * try/catch in provision(), which routes to markFailed() and the
   * job ends cleanly. The error message is preserved so the admin's
   * cancel reason shows up in the failure log.
   */
  private async checkCancellation(): Promise<void> {
    const row = await this.prisma.provisionJob.findUnique({
      where: { id: this.provisionId },
      select: { status: true, error: true },
    })
    if (row?.status === 'CANCELLED') {
      throw new Error(row.error ?? 'Provisioning cancelled by admin')
    }
  }

  private async markFailed(error: string): Promise<void> {
    await this.prisma.provisionJob.update({
      where: { id: this.provisionId },
      data: {
        status: 'FAILED',
        error,
        completedAt: new Date(),
      },
    })
    this.emit('failed', error)
  }

  private async markCompleted(nodeId: string): Promise<void> {
    await this.prisma.provisionJob.update({
      where: { id: this.provisionId },
      data: {
        status: 'COMPLETED',
        nodeId,
        completedAt: new Date(),
      },
    })
    this.emit('completed', nodeId)
  }

  async provision(config: ProvisionConfig): Promise<void> {
    // Test mode short-circuits the entire SSH flow. Used for QA and demos
    // where there is no real GPU server reachable. Simulates each of the 7
    // steps with brief delays so the UI animation still runs, then creates
    // a real Node row in the database tagged as a mock so the rest of the
    // platform (heartbeats, dashboards, routing) can exercise it.
    if (config.testMode) {
      try {
        await this.simulateProvision(config)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        await this.log('error', `Test-mode provisioning failed: ${message}`)
        await this.markFailed(message)
        throw error
      }
      return
    }

    const credentials: SSHCredentials = {
      host: config.host,
      port: config.port,
      username: config.username,
      authMethod: config.authMethod,
      password: config.password,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
    }

    try {
      // Step 1: Connect
      await this.checkCancellation()
      await this.updateStatus('CONNECTING', 1, PROVISION_STEPS[0].action)
      await this.log('info', `Connecting to ${config.host}:${config.port}...`)

      this.sshClient = new SSHClient()
      this.sshClient.on('stdout', (data) => this.emit('stdout', data))
      this.sshClient.on('stderr', (data) => this.emit('stderr', data))

      await this.sshClient.connect(credentials)
      await this.log('info', 'SSH connection established')

      // Detect if running as root (to skip sudo)
      await this.detectRootUser()

      // Step 2: Verify prerequisites
      await this.checkCancellation()
      await this.updateStatus('VERIFYING', 2, PROVISION_STEPS[1].action)
      await this.verifyPrerequisites(config.gpuTier, config.testMode)

      // Step 3: Download agent
      await this.checkCancellation()
      await this.updateStatus('DOWNLOADING', 3, PROVISION_STEPS[2].action)
      await this.downloadAgent()

      // Step 4: Install agent
      await this.checkCancellation()
      await this.updateStatus('INSTALLING', 4, PROVISION_STEPS[3].action)
      await this.installAgent()

      // Step 5: Configure agent
      await this.checkCancellation()
      await this.updateStatus('CONFIGURING', 5, PROVISION_STEPS[4].action)
      await this.configureAgent(config)

      // Step 6: Start service
      await this.checkCancellation()
      await this.updateStatus('STARTING', 6, PROVISION_STEPS[5].action)
      await this.startService()

      // Step 7: Wait for registration
      await this.checkCancellation()
      await this.updateStatus('WAITING_REGISTRATION', 7, PROVISION_STEPS[6].action)
      const nodeId = await this.waitForRegistration(config.host)

      // Complete
      await this.markCompleted(nodeId)
      await this.log('info', `Node registered successfully with ID: ${nodeId}`)

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      await this.log('error', `Provisioning failed: ${message}`)
      await this.markFailed(message)
      throw error
    } finally {
      this.sshClient?.disconnect()
    }
  }

  /**
   * Test-mode provisioning: simulate the 7-step flow without any SSH I/O,
   * then create a real Node row in Postgres so the rest of the platform
   * can exercise it. Total wall time ~3 seconds.
   */
  private async simulateProvision(config: ProvisionConfig): Promise<void> {
    const stepDelayMs = 400 // Short delay per step so the UI shows progress

    await this.log('info', 'TEST MODE: skipping all SSH operations')
    await this.log('warn', 'This node will not actually run jobs. For QA only.')

    // for-of so TypeScript narrows `step` to non-undefined.
    // PROVISION_STEPS is `as const` so length and items are statically typed,
    // but indexing by number under strict mode still yields `T | undefined`.
    let stepNumber = 0
    for (const step of PROVISION_STEPS) {
      await this.checkCancellation()
      stepNumber += 1
      await this.updateStatus(step.status, stepNumber, step.action)
      await this.log('info', `[test-mode] ${step.action} (simulated)`)
      await new Promise((r) => setTimeout(r, stepDelayMs))
    }

    // Find the provision job to discover any linked investment, so we can
    // attach the new node to the same node runner. If there's no link
    // (admin-direct-add flow), the node is created without an owner and the
    // admin can assign one later.
    const provisionJob = await this.prisma.provisionJob.findUnique({
      where: { id: this.provisionId },
      select: { id: true, gpuTier: true, region: true, nodeName: true },
    })
    if (!provisionJob) {
      throw new Error('Provision job not found')
    }

    // An investment may be linked back to this provisionJob via
    // Investment.provisionJobId. If so, use its nodeRunnerId.
    const investment = await this.prisma.investment.findFirst({
      where: { provisionJobId: this.provisionId },
      select: { nodeRunnerId: true },
    })

    // Create the Node row. Wallet address must be unique; generate a
    // distinct test wallet derived from the provisionId.
    const walletAddress = `TEST${this.provisionId.toUpperCase().slice(0, 28)}`.padEnd(44, 'x')

    const node = await this.prisma.node.create({
      data: {
        walletAddress,
        gpuTier: config.gpuTier,
        nodeType: 'PROVISIONED',
        status: 'ONLINE',
        region: config.region ?? null,
        nodeRunnerId: investment?.nodeRunnerId ?? null,
        apiKey: this.apiKey,
        agentVersion: 'test-mode-1.0.0',
        lastHeartbeat: new Date(),
        missedBeats: 0,
        customGpuModel: config.customGpuModel ?? null,
        customRatePerDay: config.customRatePerDay ?? null,
      },
    })

    // Seed a single heartbeat so the node-detail page has data immediately.
    await this.prisma.heartbeat.create({
      data: {
        nodeId: node.id,
        gpuUtilization: 0,
        gpuTemperature: 45,
        gpuMemoryUsed: 0,
        gpuMemoryTotal: 80,
        timestamp: new Date(),
      },
    })

    // If this provision came from an investment, flip the investment status
    // and stamp provisionedAt so the runner portal reflects it.
    if (investment) {
      await this.prisma.investment.updateMany({
        where: { provisionJobId: this.provisionId },
        data: {
          status: 'PROVISIONED',
          nodeId: node.id,
          provisionedAt: new Date(),
        },
      })
    }

    await this.markCompleted(node.id)
    await this.log('info', `Test-mode node created: ${node.id}`)
  }

  private async verifyPrerequisites(expectedGpuTier: GpuTier, testMode?: boolean): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    // Check OS
    await this.log('info', 'Checking operating system...')
    const osResult = await this.sshClient.exec('cat /etc/os-release')
    if (osResult.code !== 0) {
      throw new Error('Failed to detect operating system')
    }
    const isDebian = osResult.stdout.includes('debian') || osResult.stdout.includes('ubuntu')
    const isRHEL = osResult.stdout.includes('rhel') || osResult.stdout.includes('centos') || osResult.stdout.includes('fedora') || osResult.stdout.includes('rocky') || osResult.stdout.includes('alma')

    if (isDebian) {
      await this.log('info', 'Detected Debian/Ubuntu based system')
    } else if (isRHEL) {
      await this.log('info', 'Detected RHEL/CentOS based system')
    } else {
      await this.log('warn', 'Unknown OS detected, will attempt Debian-style installation')
    }

    // Check Docker - install if missing
    await this.log('info', 'Checking Docker installation...')
    const dockerResult = await this.sshClient.exec('docker --version')
    if (dockerResult.code !== 0) {
      await this.log('info', 'Docker not found, installing automatically...')
      await this.installDocker(isDebian, isRHEL)
    } else {
      await this.log('info', `Docker found: ${dockerResult.stdout.trim()}`)
    }

    // Skip GPU verification in test mode
    if (testMode) {
      await this.log('info', 'TEST MODE: Skipping GPU verification')
      await this.log('warn', 'Node will use mock GPU metrics - not suitable for production workloads')
      return
    }

    // Check NVIDIA driver
    await this.log('info', 'Checking NVIDIA driver...')
    const nvidiaResult = await this.sshClient.exec('nvidia-smi --query-gpu=driver_version --format=csv,noheader')
    if (nvidiaResult.code !== 0) {
      throw new Error('NVIDIA driver not found. Please install NVIDIA driver 535+ first.')
    }
    const driverVersion = nvidiaResult.stdout.trim()
    await this.log('info', `NVIDIA driver found: ${driverVersion}`)

    // Check GPU model
    await this.log('info', 'Detecting GPU model...')
    const gpuResult = await this.sshClient.exec('nvidia-smi --query-gpu=name --format=csv,noheader')
    if (gpuResult.code !== 0) {
      throw new Error('Failed to detect GPU model')
    }
    const gpuModel = gpuResult.stdout.trim().split('\n')[0] || 'Unknown'
    await this.log('info', `GPU detected: ${gpuModel}`)

    // Verify GPU tier matches
    const detectedTier = this.detectGpuTier(gpuModel)
    if (detectedTier !== expectedGpuTier) {
      await this.log('warn', `Expected GPU tier ${expectedGpuTier} but detected ${detectedTier}`)
    }

    // Check NVIDIA Container Toolkit - install if missing
    await this.log('info', 'Checking NVIDIA Container Toolkit...')
    const nctResult = await this.sshClient.exec('nvidia-container-cli --version')
    if (nctResult.code !== 0) {
      await this.log('info', 'NVIDIA Container Toolkit not found, installing automatically...')
      await this.installNvidiaContainerToolkit(isDebian, isRHEL)
    } else {
      await this.log('info', 'NVIDIA Container Toolkit found')
    }

    // Check Docker can access GPU
    await this.log('info', 'Verifying Docker GPU access...')
    const dockerGpuResult = await this.sshClient.exec('docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi -L', 60000)
    if (dockerGpuResult.code !== 0) {
      throw new Error('Docker cannot access GPU. Please ensure nvidia-container-toolkit is properly configured.')
    }
    await this.log('info', 'Docker GPU access verified')
  }

  private detectGpuTier(gpuModel: string): GpuTier {
    const model = gpuModel.toUpperCase()
    if (model.includes('H100')) return 'H100'
    if (model.includes('H200')) return 'H200'
    if (model.includes('B200')) return 'B200'
    if (model.includes('B300')) return 'B300'
    if (model.includes('GB300')) return 'GB300'
    return 'H100' // Default fallback
  }

  private async installDocker(isDebian: boolean, isRHEL: boolean): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    if (isDebian) {
      // Install Docker on Debian/Ubuntu
      await this.log('info', 'Installing Docker on Debian/Ubuntu...')

      // Install prerequisites
      const prepResult = await this.sshClient.exec(
        `${this.sudo}apt-get update && ${this.sudo}apt-get install -y ca-certificates curl gnupg`,
        120000
      )
      if (prepResult.code !== 0) {
        throw new Error(`Failed to install Docker prerequisites: ${prepResult.stderr}`)
      }

      // Add Docker GPG key
      await this.log('info', 'Adding Docker repository...')
      const gpgResult = await this.sshClient.exec(`
        ${this.sudo}install -m 0755 -d /etc/apt/keyrings &&
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | ${this.sudo}gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes &&
        ${this.sudo}chmod a+r /etc/apt/keyrings/docker.gpg
      `, 60000)
      if (gpgResult.code !== 0) {
        // Try Debian-style if Ubuntu fails
        await this.sshClient.exec(`
          curl -fsSL https://download.docker.com/linux/debian/gpg | ${this.sudo}gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes &&
          ${this.sudo}chmod a+r /etc/apt/keyrings/docker.gpg
        `, 60000)
      }

      // Add Docker repository
      const repoResult = await this.sshClient.exec(`
        . /etc/os-release &&
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/\${ID} \${VERSION_CODENAME} stable" |
        ${this.sudo}tee /etc/apt/sources.list.d/docker.list > /dev/null
      `, 30000)
      if (repoResult.code !== 0) {
        await this.log('warn', 'Failed to add Docker repo, trying alternative method...')
      }

      // Install Docker
      await this.log('info', 'Installing Docker packages...')
      const installResult = await this.sshClient.exec(
        `${this.sudo}apt-get update && ${this.sudo}apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`,
        300000 // 5 minutes for install
      )
      if (installResult.code !== 0) {
        throw new Error(`Failed to install Docker: ${installResult.stderr}`)
      }

    } else if (isRHEL) {
      // Install Docker on RHEL/CentOS/Fedora
      await this.log('info', 'Installing Docker on RHEL-based system...')

      const installResult = await this.sshClient.exec(`
        ${this.sudo}yum install -y yum-utils &&
        ${this.sudo}yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo &&
        ${this.sudo}yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      `, 300000)
      if (installResult.code !== 0) {
        throw new Error(`Failed to install Docker: ${installResult.stderr}`)
      }

    } else {
      throw new Error('Unsupported OS for automatic Docker installation. Please install Docker manually.')
    }

    // Start and enable Docker
    await this.log('info', 'Starting Docker service...')
    const startResult = await this.sshClient.exec(`${this.sudo}systemctl start docker && ${this.sudo}systemctl enable docker`)
    if (startResult.code !== 0) {
      throw new Error(`Failed to start Docker: ${startResult.stderr}`)
    }

    // Verify installation
    const verifyResult = await this.sshClient.exec('docker --version')
    if (verifyResult.code !== 0) {
      throw new Error('Docker installation verification failed')
    }
    await this.log('info', `Docker installed successfully: ${verifyResult.stdout.trim()}`)
  }

  private async installNvidiaContainerToolkit(isDebian: boolean, isRHEL: boolean): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    if (isDebian) {
      // Install NVIDIA Container Toolkit on Debian/Ubuntu
      await this.log('info', 'Installing NVIDIA Container Toolkit on Debian/Ubuntu...')

      // Add NVIDIA GPG key and repository
      const repoResult = await this.sshClient.exec(`
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | ${this.sudo}gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg --yes &&
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list |
          sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' |
          ${this.sudo}tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
      `, 60000)
      if (repoResult.code !== 0) {
        throw new Error(`Failed to add NVIDIA Container Toolkit repository: ${repoResult.stderr}`)
      }

      // Install the toolkit
      await this.log('info', 'Installing nvidia-container-toolkit package...')
      const installResult = await this.sshClient.exec(
        `${this.sudo}apt-get update && ${this.sudo}apt-get install -y nvidia-container-toolkit`,
        180000
      )
      if (installResult.code !== 0) {
        throw new Error(`Failed to install NVIDIA Container Toolkit: ${installResult.stderr}`)
      }

    } else if (isRHEL) {
      // Install NVIDIA Container Toolkit on RHEL/CentOS
      await this.log('info', 'Installing NVIDIA Container Toolkit on RHEL-based system...')

      const installResult = await this.sshClient.exec(`
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo |
          ${this.sudo}tee /etc/yum.repos.d/nvidia-container-toolkit.repo &&
        ${this.sudo}yum install -y nvidia-container-toolkit
      `, 180000)
      if (installResult.code !== 0) {
        throw new Error(`Failed to install NVIDIA Container Toolkit: ${installResult.stderr}`)
      }

    } else {
      throw new Error('Unsupported OS for automatic NVIDIA Container Toolkit installation.')
    }

    // Configure Docker to use NVIDIA runtime
    await this.log('info', 'Configuring Docker to use NVIDIA runtime...')
    const configResult = await this.sshClient.exec(`${this.sudo}nvidia-ctk runtime configure --runtime=docker`)
    if (configResult.code !== 0) {
      await this.log('warn', `nvidia-ctk configure warning: ${configResult.stderr}`)
    }

    // Restart Docker to apply changes
    await this.log('info', 'Restarting Docker to apply NVIDIA runtime configuration...')
    const restartResult = await this.sshClient.exec(`${this.sudo}systemctl restart docker`)
    if (restartResult.code !== 0) {
      throw new Error(`Failed to restart Docker: ${restartResult.stderr}`)
    }

    // Verify installation
    const verifyResult = await this.sshClient.exec('nvidia-container-cli --version')
    if (verifyResult.code !== 0) {
      throw new Error('NVIDIA Container Toolkit installation verification failed')
    }
    await this.log('info', `NVIDIA Container Toolkit installed successfully: ${verifyResult.stdout.trim()}`)
  }

  private async downloadAgent(): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    // Check for Node.js - required to run the agent
    await this.log('info', 'Checking Node.js installation...')
    const nodeResult = await this.sshClient.exec('node --version')
    if (nodeResult.code !== 0) {
      await this.log('info', 'Node.js not found, installing...')
      await this.installNodeJs()
    } else {
      await this.log('info', `Node.js found: ${nodeResult.stdout.trim()}`)
    }

    await this.log('info', 'Creating installation directory...')
    await this.sshClient.exec(`${this.sudo}mkdir -p /opt/a2e-agent/bin`)

    // Detect architecture
    const archResult = await this.sshClient.exec('uname -m')
    const arch = archResult.stdout.trim() === 'aarch64' ? 'arm64' : 'x64'
    await this.log('info', `Detected architecture: ${arch}`)

    const binaryUrl = `${this.apiUrl}/releases/latest/a2e-agent-linux-${arch}`
    const checksumUrl = `${this.apiUrl}/releases/latest/checksums.txt`

    // Download agent bundle
    await this.log('info', `Downloading agent from ${binaryUrl}...`)
    const downloadResult = await this.sshClient.exec(
      `${this.sudo}curl -fSL -o /opt/a2e-agent/bin/a2e-agent '${binaryUrl}'`,
      300000 // 5 min timeout for download
    )
    if (downloadResult.code !== 0) {
      throw new Error(`Failed to download agent: ${downloadResult.stderr}`)
    }

    // Download and verify checksum
    await this.log('info', 'Verifying checksum...')
    const checksumResult = await this.sshClient.exec(
      `cd /opt/a2e-agent/bin && curl -fsSL '${checksumUrl}' | grep "a2e-agent-linux-${arch}" | sha256sum -c -`
    )
    if (checksumResult.code !== 0) {
      await this.log('warn', 'Checksum verification failed, continuing anyway')
    } else {
      await this.log('info', 'Checksum verified')
    }

    // Make executable
    await this.sshClient.exec(`${this.sudo}chmod +x /opt/a2e-agent/bin/a2e-agent`)
    await this.log('info', 'Agent downloaded and verified')
  }

  private async installNodeJs(): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    // Install Node.js via NodeSource (v20 LTS)
    await this.log('info', 'Installing Node.js 20 LTS via NodeSource...')

    // Check OS type for the right installation method
    const osResult = await this.sshClient.exec('cat /etc/os-release')
    const isDebian = osResult.stdout.includes('debian') || osResult.stdout.includes('ubuntu')
    const isRHEL = osResult.stdout.includes('rhel') || osResult.stdout.includes('centos') || osResult.stdout.includes('fedora')

    if (isDebian) {
      // Install via NodeSource for Debian/Ubuntu
      const installResult = await this.sshClient.exec(`
        ${this.sudo}apt-get update &&
        ${this.sudo}apt-get install -y ca-certificates curl gnupg &&
        ${this.sudo}mkdir -p /etc/apt/keyrings &&
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | ${this.sudo}gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes &&
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | ${this.sudo}tee /etc/apt/sources.list.d/nodesource.list &&
        ${this.sudo}apt-get update &&
        ${this.sudo}apt-get install -y nodejs
      `, 300000)
      if (installResult.code !== 0) {
        throw new Error(`Failed to install Node.js: ${installResult.stderr}`)
      }
    } else if (isRHEL) {
      // Install via NodeSource for RHEL/CentOS
      const installResult = await this.sshClient.exec(`
        ${this.sudo}yum install -y curl &&
        curl -fsSL https://rpm.nodesource.com/setup_20.x | ${this.sudo}bash - &&
        ${this.sudo}yum install -y nodejs
      `, 300000)
      if (installResult.code !== 0) {
        throw new Error(`Failed to install Node.js: ${installResult.stderr}`)
      }
    } else {
      throw new Error('Unsupported OS for automatic Node.js installation')
    }

    // Verify installation
    const verifyResult = await this.sshClient.exec('node --version')
    if (verifyResult.code !== 0) {
      throw new Error('Node.js installation verification failed')
    }
    await this.log('info', `Node.js installed successfully: ${verifyResult.stdout.trim()}`)
  }

  private async installAgent(): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    // Create directories
    await this.log('info', 'Creating directories...')
    await this.sshClient.exec(`${this.sudo}mkdir -p /etc/a2e-agent /var/lib/a2e-agent /var/log/a2e-agent`)
    await this.sshClient.exec(`${this.sudo}chmod 700 /etc/a2e-agent`)
    await this.sshClient.exec(`${this.sudo}chmod 755 /var/lib/a2e-agent /var/log/a2e-agent`)

    // Create symlink to /usr/local/bin
    await this.log('info', 'Creating symlink...')
    await this.sshClient.exec(`${this.sudo}ln -sf /opt/a2e-agent/bin/a2e-agent /usr/local/bin/a2e-agent`)

    await this.log('info', 'Agent installed to /opt/a2e-agent')
  }

  private async configureAgent(config: ProvisionConfig): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    await this.log('info', 'Generating configuration...')

    // Build GPU configuration section
    let gpuConfig = `gpu:
  autoDetect: true
  tier: ${config.gpuTier}`

    // Add mock GPU settings in test mode
    if (config.testMode) {
      gpuConfig = `gpu:
  autoDetect: false
  tier: ${config.gpuTier}
  mockGpu: true
  mockModel: "NVIDIA ${config.gpuTier} (Mock)"
  mockVram: 81920`
      await this.log('info', 'TEST MODE: Configuring mock GPU')
    }

    const configContent = `# A²E Node Agent Configuration
# Generated by SSH Provisioning on ${new Date().toISOString()}
${config.testMode ? '# TEST MODE ENABLED - Using mock GPU\n' : ''}
server:
  apiUrl: ${this.apiUrl}
  apiKey: ${this.apiKey}

agent:
  name: ${config.nodeName || config.host}
  heartbeatInterval: 30
  jobPollInterval: 10

${gpuConfig}

docker:
  socketPath: /var/run/docker.sock
  gpuRuntime: nvidia

logging:
  level: info
  pretty: false

security:
  restrictCapabilities: true
  readOnlyRootfs: true
  dropCapabilities: true
`

    // Write config file
    await this.log('info', 'Writing configuration file...')
    const escapedConfig = configContent.replace(/'/g, "'\\''")
    await this.sshClient.exec(`echo '${escapedConfig}' | ${this.sudo}tee /etc/a2e-agent/agent.yaml > /dev/null`)
    await this.sshClient.exec(`${this.sudo}chmod 600 /etc/a2e-agent/agent.yaml`)

    // Install systemd service
    await this.log('info', 'Installing systemd service...')
    const serviceContent = `[Unit]
Description=A²E Node Agent - GPU Compute Orchestration
Documentation=https://admin.tokenos.ai/docs
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
Group=root
ExecStart=/opt/a2e-agent/bin/a2e-agent --config /etc/a2e-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=a2e-agent
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`

    const escapedService = serviceContent.replace(/'/g, "'\\''")
    await this.sshClient.exec(`echo '${escapedService}' | ${this.sudo}tee /etc/systemd/system/a2e-agent.service > /dev/null`)
    await this.sshClient.exec(`${this.sudo}systemctl daemon-reload`)

    await this.log('info', 'Configuration complete')
  }

  private async startService(): Promise<void> {
    if (!this.sshClient) throw new Error('SSH client not connected')

    await this.log('info', 'Enabling and starting service...')
    const enableResult = await this.sshClient.exec(`${this.sudo}systemctl enable a2e-agent`)
    if (enableResult.code !== 0) {
      throw new Error(`Failed to enable service: ${enableResult.stderr}`)
    }

    const startResult = await this.sshClient.exec(`${this.sudo}systemctl start a2e-agent`)
    if (startResult.code !== 0) {
      throw new Error(`Failed to start service: ${startResult.stderr}`)
    }

    // Wait a moment for service to start
    await new Promise(resolve => setTimeout(resolve, 3000))

    // Check service status
    const statusResult = await this.sshClient.exec(`${this.sudo}systemctl is-active a2e-agent`)
    if (statusResult.stdout.trim() !== 'active') {
      // Get logs for debugging
      const logsResult = await this.sshClient.exec(`${this.sudo}journalctl -u a2e-agent -n 20 --no-pager`)
      await this.log('error', `Service logs:\n${logsResult.stdout}`)
      throw new Error('Service failed to start. Check logs above.')
    }

    await this.log('info', 'Service started successfully')
  }

  private async waitForRegistration(host: string, maxWaitMs: number = 60000): Promise<string> {
    await this.log('info', 'Waiting for node to register with A²E...')

    const startTime = Date.now()
    const pollInterval = 3000

    while (Date.now() - startTime < maxWaitMs) {
      // Check if our provision job now has a linked nodeId
      // This happens when the agent registers using our API key
      const provisionJob = await this.prisma.provisionJob.findUnique({
        where: { id: this.provisionId },
        select: { nodeId: true },
      })

      if (provisionJob?.nodeId) {
        await this.log('info', `Node registered: ${provisionJob.nodeId}`)
        return provisionJob.nodeId
      }

      // Also check for nodes that registered with our API key
      const node = await this.prisma.node.findUnique({
        where: { apiKey: this.apiKey },
        select: { id: true },
      })

      if (node) {
        // Link the node to our provision job if not already linked
        await this.prisma.provisionJob.update({
          where: { id: this.provisionId },
          data: { nodeId: node.id },
        })
        await this.log('info', `Node registered: ${node.id}`)
        return node.id
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
      await this.log('info', 'Still waiting for registration...')
    }

    throw new Error('Timeout waiting for node registration. The agent may still be starting up.')
  }

  getApiKey(): string {
    return this.apiKey
  }
}
