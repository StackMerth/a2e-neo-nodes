import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

// Agent bundle path - in production this would be in a releases directory
const RELEASES_DIR = process.env.RELEASES_DIR || path.join(process.cwd(), '..', 'node-agent', 'dist')

export async function releasesRoutes(fastify: FastifyInstance) {
  /**
   * GET /releases/latest/a2e-agent-linux-x64
   * Download the agent bundle (Node.js script)
   */
  fastify.get('/releases/latest/a2e-agent-linux-:arch', async (request, reply) => {
    const { arch } = request.params as { arch: string }

    // The bundle is architecture-independent since it's JavaScript
    const bundlePath = path.join(RELEASES_DIR, 'bundle.js')

    if (!fs.existsSync(bundlePath)) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Agent bundle not found. Ensure the node-agent has been built.',
      })
    }

    const bundle = fs.readFileSync(bundlePath)

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="a2e-agent-linux-${arch}"`)
      .send(bundle)
  })

  /**
   * GET /releases/latest/checksums.txt
   * Get SHA256 checksums for release files
   */
  fastify.get('/releases/latest/checksums.txt', async (request, reply) => {
    const bundlePath = path.join(RELEASES_DIR, 'bundle.js')

    if (!fs.existsSync(bundlePath)) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Agent bundle not found.',
      })
    }

    const bundle = fs.readFileSync(bundlePath)
    const hash = crypto.createHash('sha256').update(bundle).digest('hex')

    // Generate checksums for both architectures (same file, same hash)
    const checksums = [
      `${hash}  a2e-agent-linux-x64`,
      `${hash}  a2e-agent-linux-arm64`,
    ].join('\n')

    reply
      .header('Content-Type', 'text/plain')
      .send(checksums)
  })

  /**
   * GET /releases/latest/version
   * Get the current agent version
   */
  fastify.get('/releases/latest/version', async (request, reply) => {
    // Read version from package.json
    const packagePath = path.join(RELEASES_DIR, '..', 'package.json')

    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))
      reply.send({ version: pkg.version || '1.0.0' })
    } catch {
      reply.send({ version: '1.0.0' })
    }
  })
}
