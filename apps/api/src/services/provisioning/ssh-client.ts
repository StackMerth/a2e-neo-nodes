import { Client, ConnectConfig } from 'ssh2'
import { EventEmitter } from 'events'

export interface SSHCredentials {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export class SSHClient extends EventEmitter {
  private client: Client
  private connected: boolean = false

  constructor() {
    super()
    this.client = new Client()
  }

  async connect(credentials: SSHCredentials): Promise<void> {
    return new Promise((resolve, reject) => {
      const config: ConnectConfig = {
        host: credentials.host,
        port: credentials.port,
        username: credentials.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000,
      }

      if (credentials.authMethod === 'password') {
        config.password = credentials.password
      } else {
        config.privateKey = credentials.privateKey
        if (credentials.passphrase) {
          config.passphrase = credentials.passphrase
        }
      }

      this.client.on('ready', () => {
        this.connected = true
        this.emit('connected')
        resolve()
      })

      this.client.on('error', (err) => {
        this.emit('error', err)
        reject(err)
      })

      this.client.on('close', () => {
        this.connected = false
        this.emit('disconnected')
      })

      this.client.connect(config)
    })
  }

  async exec(command: string, timeout: number = 120000): Promise<CommandResult> {
    if (!this.connected) {
      throw new Error('SSH client not connected')
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeout}ms: ${command}`))
      }, timeout)

      this.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId)
          reject(err)
          return
        }

        let stdout = ''
        let stderr = ''

        stream.on('close', (code: number) => {
          clearTimeout(timeoutId)
          resolve({ stdout, stderr, code: code ?? 0 })
        })

        stream.on('data', (data: Buffer) => {
          const text = data.toString()
          stdout += text
          this.emit('stdout', text)
        })

        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString()
          stderr += text
          this.emit('stderr', text)
        })
      })
    })
  }

  async execWithSudo(command: string, password?: string): Promise<CommandResult> {
    // For commands that need sudo
    const sudoCommand = password
      ? `echo '${password}' | sudo -S ${command}`
      : `sudo ${command}`
    return this.exec(sudoCommand)
  }

  async uploadFile(localContent: string, remotePath: string): Promise<void> {
    if (!this.connected) {
      throw new Error('SSH client not connected')
    }

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err)
          return
        }

        const writeStream = sftp.createWriteStream(remotePath)
        writeStream.on('close', () => {
          sftp.end()
          resolve()
        })
        writeStream.on('error', (error: Error) => {
          sftp.end()
          reject(error)
        })
        writeStream.write(localContent)
        writeStream.end()
      })
    })
  }

  disconnect(): void {
    if (this.connected) {
      this.client.end()
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }
}
