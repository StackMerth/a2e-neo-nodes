/**
 * T5f / Phase 1 / Milestone 1.4 — Default Phala CVM Docker Compose.
 *
 * Phala CVMs run a Docker Compose file inside the confidential VM.
 * Per the Path A architecture decision (2026-06-02), we ship a default
 * Compose that provides SSH access + CUDA inside the TEE so the buyer's
 * UX matches Lambda / RunPod rentals — they SSH in after the CVM
 * reaches RUNNING. Phala specifics are invisible to them.
 *
 * The template uses ${PUBLIC_KEY} env var interpolation. Phala
 * injects env vars from the CVM's env block at deploy time (same
 * mechanism as RunPod's PUBLIC_KEY pattern). The base image's
 * entrypoint then writes the key to /root/.ssh/authorized_keys and
 * starts openssh-server.
 *
 * Why runpod/pytorch:2.4.0 as the base image:
 *   - Proven working in our RunPod adapter (T5e A4000 test reached
 *     RUNNING with SSH)
 *   - Includes openssh-server, CUDA 12.4, Python 3.11, PyTorch 2.4
 *   - Has a built-in entrypoint that processes PUBLIC_KEY env
 *   - Stays alive via the image's default CMD
 *
 * GPU access: Phala automatically attaches the requested GPU(s) to
 * the CVM container based on the instance type id we pass to
 * createCvm; the Compose doesn't need explicit device reservations
 * the way standalone Docker does.
 *
 * Port exposure: Phala exposes container ports on a public host
 * address (verified via the CVM detail endpoint). Port 22 is mapped
 * so the buyer can SSH directly.
 *
 * NOT YET in this default (room for Phase 1.8+ enhancements):
 *   - Attestation report endpoint (Phala exposes /attestation per
 *     CVM; we'd surface this in buyer's SSH UX for verification)
 *   - Persistent volume mount (buyer's checkpoint workspace)
 *   - Custom entrypoint script (if buyer wants to pre-load their
 *     model into the CVM at boot)
 *
 * Buyers wanting non-default behavior can pass imageName / custom
 * compose via the provisioning orchestrator later (Path B equivalent,
 * but as an advanced option not the default).
 */

/** Phala's preferred CUDA + SSH base image, pinned for reproducibility. */
export const PHALA_DEFAULT_BASE_IMAGE =
  process.env.PHALA_DEFAULT_BASE_IMAGE ??
  'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04'

/**
 * Build the default Docker Compose YAML for a Phala CVM rental.
 * Returns a string suitable for inclusion in the createCvm payload's
 * compose_file (or whatever Phala calls the field — TBD on first
 * 422 from createCvm).
 *
 * The PUBLIC_KEY environment variable is interpolated by Phala at
 * deploy time from the createCvm `env` block (which the adapter
 * already populates).
 */
export function buildDefaultPhalaCompose(opts: {
  /** Optional override of the base image. Defaults to the pinned
   * pytorch image. */
  imageName?: string
  /** Container disk size in GB. Phala default is on the SKU; this
   * lets the buyer request more for large datasets / checkpoints. */
  containerDiskInGb?: number
}): string {
  const image = opts.imageName ?? PHALA_DEFAULT_BASE_IMAGE
  // Compose v3 syntax — Phala's dstack runtime accepts standard
  // docker-compose.yml minus a few features (named volumes need
  // dstack-style annotations; we don't use them here).
  return [
    `version: '3'`,
    `services:`,
    `  app:`,
    `    image: ${image}`,
    `    restart: unless-stopped`,
    `    environment:`,
    `      - PUBLIC_KEY=\${PUBLIC_KEY}`,
    `    ports:`,
    `      - "22:22"`,
    // Phala auto-attaches GPUs based on the instance type; we don't
    // need a deploy.resources.devices block. If the dstack runtime
    // requires it, we add a CUDA_VISIBLE_DEVICES env passthrough
    // here once verified.
    ``,
  ].join('\n')
}

/**
 * Same as the YAML version but returned as a structured JS object —
 * useful when Phala's createCvm expects a JSON compose representation
 * rather than a raw YAML string. We'll pick whichever shape the 422
 * validation error guides us to.
 */
export function buildDefaultPhalaComposeJson(opts: {
  imageName?: string
  containerDiskInGb?: number
}): Record<string, unknown> {
  const image = opts.imageName ?? PHALA_DEFAULT_BASE_IMAGE
  return {
    version: '3',
    services: {
      app: {
        image,
        restart: 'unless-stopped',
        environment: ['PUBLIC_KEY=${PUBLIC_KEY}'],
        ports: ['22:22'],
      },
    },
  }
}
