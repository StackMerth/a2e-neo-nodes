/**
 * Track 5 / E3.3 — multipart/form-data plugin.
 *
 * Registered globally so any route can opt in to multipart uploads via
 * request.file() / request.parts(). Currently the only consumer is
 * /v1/audio/transcriptions (file upload + form fields for Whisper).
 *
 * Limits matched to OpenAI's published Whisper limit: 25 MB per file,
 * and a single file per request. Larger uploads are rejected at the
 * parser level with a 413 before they hit the route handler.
 *
 * No global option in 8.x for "treat everything as multipart" — routes
 * still need to opt in via request.file() (the standard pattern).
 */

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import multipart from '@fastify/multipart'

const multipartPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  await fastify.register(multipart, {
    limits: {
      // Whisper / transcription default. Matches OpenAI's public limit.
      // Override per-route with request.file({ limits: { fileSize } })
      // if a model accepts larger inputs.
      fileSize: 25 * 1024 * 1024, // 25 MB
      files: 1,
      // Form fields alongside the file (model, language, prompt etc.)
      // Cap at 32 to leave room for openai-compat extensions.
      fields: 32,
      fieldSize: 16 * 1024, // 16 KB per field — prompts, language ids, etc.
    },
  })
}

export default fp(multipartPlugin, {
  name: 'multipart',
  dependencies: [],
})
