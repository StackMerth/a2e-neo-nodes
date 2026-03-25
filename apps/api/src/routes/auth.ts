import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import crypto from 'crypto'

// Simple admin credentials - in production, use proper user management
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'a2e-admin-2026'
const JWT_SECRET = process.env.JWT_SECRET || 'a2e-jwt-secret-change-in-production'

// Simple JWT-like token generation (for demo purposes)
function generateToken(username: string): string {
  const payload = {
    username,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    iat: Date.now(),
  }
  const data = Buffer.from(JSON.stringify(payload)).toString('base64')
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
  return `${data}.${signature}`
}

function verifyToken(token: string): { valid: boolean; username?: string; expired?: boolean } {
  try {
    const [data, signature] = token.split('.')
    if (!data || !signature) return { valid: false }

    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(data)
      .digest('base64')

    if (signature !== expectedSignature) return { valid: false }

    const payload = JSON.parse(Buffer.from(data, 'base64').toString())

    if (payload.exp < Date.now()) {
      return { valid: false, expired: true }
    }

    return { valid: true, username: payload.username }
  } catch {
    return { valid: false }
  }
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export async function authRoutes(fastify: FastifyInstance) {
  // Login endpoint
  fastify.post('/v1/auth/login', async (request, reply) => {
    const parseResult = loginSchema.safeParse(request.body)

    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: 'Username and password are required',
      })
    }

    const { username, password } = parseResult.data

    // Validate credentials
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid username or password',
      })
    }

    // Generate token
    const token = generateToken(username)

    reply.send({
      success: true,
      token,
      user: {
        username,
        role: 'admin',
      },
      expiresIn: 24 * 60 * 60, // 24 hours in seconds
    })
  })

  // Verify token endpoint
  fastify.post('/v1/auth/verify', async (request, reply) => {
    const authHeader = request.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'No token provided',
      })
    }

    const token = authHeader.substring(7)
    const result = verifyToken(token)

    if (!result.valid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: result.expired ? 'Token expired' : 'Invalid token',
        expired: result.expired,
      })
    }

    reply.send({
      valid: true,
      user: {
        username: result.username,
        role: 'admin',
      },
    })
  })

  // Logout endpoint (client-side token removal, but we can log it)
  fastify.post('/v1/auth/logout', async (request, reply) => {
    // In a real implementation, you might blacklist the token
    reply.send({
      success: true,
      message: 'Logged out successfully',
    })
  })
}
