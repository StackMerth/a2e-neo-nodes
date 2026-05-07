// Overflow Adapter Registry Plugin (M7)
//
// Provides a single `AdapterRegistry` instance scoped to the Fastify lifecycle,
// with all three external-market adapters registered. Routes and jobs access
// the registry via `fastify.overflowRegistry`. Health probes start on boot and
// stop on server close so nothing leaks in tests or during graceful shutdown.

import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import { AdapterRegistry, IONetAdapter, VastAiAdapter } from '@a2e/core'

declare module 'fastify' {
  interface FastifyInstance {
    overflowRegistry: AdapterRegistry
  }
}

// Akash adapter is intentionally not registered here. The @akashnetwork/chain-sdk
// dependency tree has unresolved ESM/CJS issues that crash module load.
// Re-enable by importing AkashAdapter directly from
// '@a2e/core/dist/adapters/akash' (or via a lazy loader) once upstream
// stabilises. AKASH_ENABLED env var is also false by default.
const overflowRegistryPluginImpl: FastifyPluginCallback = async (fastify: FastifyInstance) => {
  const registry = new AdapterRegistry()
  registry.register(new IONetAdapter())
  registry.register(new VastAiAdapter())
  registry.start()

  fastify.addHook('onClose', async () => {
    registry.stop()
  })

  fastify.decorate('overflowRegistry', registry)
}

export const overflowRegistryPlugin = fp(overflowRegistryPluginImpl, {
  name: 'overflow-registry',
})

export default overflowRegistryPlugin
