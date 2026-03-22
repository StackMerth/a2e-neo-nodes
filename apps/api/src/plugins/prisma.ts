// Prisma Plugin for Fastify
// Provides database access via request.prisma

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import { prisma, type PrismaClient } from '@a2e/database'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

const prismaPlugin: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  fastify.decorate('prisma', prisma)

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
}

export default fp(prismaPlugin, {
  name: 'prisma',
})
