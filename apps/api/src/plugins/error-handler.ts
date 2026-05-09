import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import * as Sentry from '@sentry/node'

interface ErrorResponse {
  error: string
  message: string
  statusCode: number
  code?: string
  requestId?: string
  timestamp: string
}

/**
 * Global error handler plugin
 * Provides consistent error responses and logging
 */
async function errorHandlerPlugin(fastify: FastifyInstance) {
  // Add request ID to all requests
  fastify.addHook('onRequest', async (request) => {
    request.requestId = request.headers['x-request-id'] as string ?? generateRequestId()
  })

  // Global error handler
  fastify.setErrorHandler(
    async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.requestId ?? 'unknown'

      // Log the error
      fastify.log.error({
        err: error,
        requestId,
        method: request.method,
        url: request.url,
        statusCode: error.statusCode ?? 500,
      })

      // Determine status code
      const statusCode = error.statusCode ?? 500

      // Forward 5xx errors to Sentry. 4xx are client errors (validation,
      // auth, not-found) and would create noise in Sentry without value.
      if (statusCode >= 500 && process.env.SENTRY_DSN) {
        Sentry.withScope((scope) => {
          scope.setTag('request_id', requestId)
          scope.setTag('method', request.method)
          scope.setTag('url', request.url)
          scope.setExtra('status_code', statusCode)
          if (request.authType) scope.setTag('auth_type', request.authType)
          Sentry.captureException(error)
        })
      }

      // Build error response
      const errorResponse: ErrorResponse = {
        error: getErrorName(statusCode),
        message: getErrorMessage(error, statusCode),
        statusCode,
        code: error.code,
        requestId,
        timestamp: new Date().toISOString(),
      }

      // Don't expose internal error details in production
      if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
        errorResponse.message = 'An internal server error occurred'
        delete errorResponse.code
      }

      return reply.status(statusCode).send(errorResponse)
    }
  )

  // Handle 404s
  fastify.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    const errorResponse: ErrorResponse = {
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
      requestId: request.requestId ?? 'unknown',
      timestamp: new Date().toISOString(),
    }

    return reply.status(404).send(errorResponse)
  })
}

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`
}

function getErrorName(statusCode: number): string {
  const names: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  }
  return names[statusCode] ?? 'Error'
}

function getErrorMessage(error: FastifyError, statusCode: number): string {
  // Use error message if provided and not a generic one
  if (error.message && error.message !== 'Internal Server Error') {
    return error.message
  }

  // Default messages
  const messages: Record<number, string> = {
    400: 'The request was invalid or cannot be processed',
    401: 'Authentication is required to access this resource',
    403: 'You do not have permission to access this resource',
    404: 'The requested resource was not found',
    409: 'The request conflicts with the current state of the resource',
    422: 'The request was well-formed but contains invalid data',
    429: 'Too many requests. Please try again later',
    500: 'An unexpected error occurred on the server',
    502: 'The server received an invalid response from an upstream server',
    503: 'The service is temporarily unavailable',
    504: 'The server did not receive a timely response from an upstream server',
  }

  return messages[statusCode] ?? 'An error occurred'
}

// Extend FastifyRequest to include requestId
declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string
  }
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
})
