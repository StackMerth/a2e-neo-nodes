/*
 * M4.7 Phase 7b: WireGuard mesh config generator.
 *
 * Given N nodes in a cluster, produces:
 *   - one Curve25519 keypair per node (private + public)
 *   - one /30 IP per node carved from the cluster's /24 subnet
 *   - one peer config per node listing every other node as a peer
 *
 * Pure function. The agent side (M4.7 Phase 7c) consumes the per-node
 * config, runs `wg-quick up`, and reports back when handshakes are
 * verified. The API distributes configs via the existing heartbeat
 * response channel so no new connection plumbing is needed.
 *
 * Subnet pool: 10.42.0.0/16 carved into /24 blocks. Each cluster owns
 * one /24 (256 hosts; supports clusters up to 64 nodes with /30 each).
 * The allocator generates a unique /24 by hashing the cluster ID into
 * the second octet range 0-255 with a small offset reservation.
 */

import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto'

const LISTEN_PORT = 51820
const SUBNET_PREFIX = '10.42'

export interface WireguardPeer {
  publicKey: string
  endpoint: string   // host:port
  allowedIp: string  // /32 of the peer
}

export interface WireguardNodeConfig {
  nodeId: string
  rank: number
  privateKey: string
  publicKey: string
  ip: string         // The node's own /30 inside the subnet
  listenPort: number
  peers: WireguardPeer[]
}

export interface WireguardClusterPlan {
  /** /24 the cluster owns, e.g. "10.42.7.0/24". */
  subnet: string
  /** Per-node config to ship to each agent. */
  nodes: WireguardNodeConfig[]
}

/**
 * Generate a Curve25519 keypair in the format WireGuard expects
 * (base64-encoded 32-byte raw scalar). node:crypto generates the
 * scalar; the public key is derived via X25519.
 */
function generateKeypair(): { privateKey: string; publicKey: string } {
  // Generate a 32-byte private scalar and clamp it per X25519 spec.
  const raw = randomBytes(32)
  raw[0] = (raw[0] ?? 0) & 248
  const lastIdx = raw.length - 1
  raw[lastIdx] = ((raw[lastIdx] ?? 0) & 127) | 64

  // Wrap in a PKCS8 DER envelope for createPrivateKey -> derive pub.
  // 16-byte X25519 PKCS8 prefix:
  //   30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex')
  const pkcs8 = Buffer.concat([pkcs8Prefix, raw])

  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  const pubExport = publicKey.export({ format: 'der', type: 'spki' })
  // SPKI prefix for X25519 is 12 bytes; the trailing 32 bytes are the raw pub key.
  const rawPub = (pubExport as Buffer).subarray(-32)

  return {
    privateKey: raw.toString('base64'),
    publicKey: rawPub.toString('base64'),
  }
}

/**
 * Carve a unique /24 from the 10.42.0.0/16 pool. Deterministic from
 * the cluster ID so a rebuild (e.g. after a transient agent crash)
 * always produces the same subnet for the same cluster. We hash the
 * cluster ID into a single byte (the third octet) and reserve octet
 * 0 + 255 for future broadcast / metadata uses.
 */
export function pickClusterSubnet(clusterId: string): string {
  // Tiny deterministic hash; 31-bit Math, not cryptographic.
  let h = 0
  for (let i = 0; i < clusterId.length; i++) {
    h = ((h << 5) - h + clusterId.charCodeAt(i)) | 0
  }
  const octet = (Math.abs(h) % 254) + 1 // 1..254
  return `${SUBNET_PREFIX}.${octet}.0/24`
}

/**
 * For a given subnet "10.42.X.0/24", return the /30-aligned IP for
 * rank N. Ranks 0..63 fit (each /30 holds 4 hosts; we use the .1 of
 * each block as the peer's address).
 *
 *   rank 0 -> 10.42.X.1
 *   rank 1 -> 10.42.X.5
 *   rank 2 -> 10.42.X.9
 *   ...
 */
function ipForRank(subnet: string, rank: number): string {
  const match = /^(\d+\.\d+\.\d+)\.0\/24$/.exec(subnet)
  if (!match) throw new Error(`malformed cluster subnet: ${subnet}`)
  const base = match[1]!
  const host = rank * 4 + 1
  if (host > 253) throw new Error(`cluster rank ${rank} exceeds /24 capacity`)
  return `${base}.${host}`
}

export interface NodeProvisioningInput {
  /** Stable node id from the Node table. */
  nodeId: string
  /** Reachable public host for the agent's WireGuard interface. */
  publicHost: string
}

/**
 * Build the mesh plan for a cluster. Caller passes the N nodes plus
 * the cluster id; this function returns one config per node ready to
 * persist + ship to the agent.
 *
 * Rank assignment is by input order. The caller decides ranking; the
 * convention is rank 0 = master (the one the buyer SSHes into).
 */
export function planClusterMesh(
  clusterId: string,
  nodes: NodeProvisioningInput[],
): WireguardClusterPlan {
  if (nodes.length === 0) throw new Error('planClusterMesh requires at least one node')
  if (nodes.length > 64) throw new Error('cluster size capped at 64 nodes for now')

  const subnet = pickClusterSubnet(clusterId)

  // Generate a keypair + IP per node.
  const provisioned = nodes.map((n, rank) => {
    const { privateKey, publicKey } = generateKeypair()
    return {
      ...n,
      rank,
      privateKey,
      publicKey,
      ip: ipForRank(subnet, rank),
    }
  })

  // For each node, every OTHER node is a peer.
  const configs: WireguardNodeConfig[] = provisioned.map(self => {
    const peers: WireguardPeer[] = provisioned
      .filter(p => p.nodeId !== self.nodeId)
      .map(p => ({
        publicKey: p.publicKey,
        endpoint: `${p.publicHost}:${LISTEN_PORT}`,
        allowedIp: `${p.ip}/32`,
      }))
    return {
      nodeId: self.nodeId,
      rank: self.rank,
      privateKey: self.privateKey,
      publicKey: self.publicKey,
      ip: self.ip,
      listenPort: LISTEN_PORT,
      peers,
    }
  })

  return { subnet, nodes: configs }
}

/**
 * Render a node's config as the standard `wg-quick` ini format. The
 * agent persists this to /etc/wireguard/wg0.conf and runs
 * `wg-quick up wg0`.
 */
export function renderWireguardConfig(cfg: WireguardNodeConfig): string {
  const peerBlocks = cfg.peers.map(p => [
    '[Peer]',
    `PublicKey = ${p.publicKey}`,
    `Endpoint = ${p.endpoint}`,
    `AllowedIPs = ${p.allowedIp}`,
    'PersistentKeepalive = 25',
  ].join('\n')).join('\n\n')

  return [
    '[Interface]',
    `PrivateKey = ${cfg.privateKey}`,
    `Address = ${cfg.ip}/24`,
    `ListenPort = ${cfg.listenPort}`,
    '',
    peerBlocks,
  ].join('\n')
}
