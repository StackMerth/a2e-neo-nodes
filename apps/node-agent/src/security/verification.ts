import { securityLogger } from '../utils/logger.js';

const log = securityLogger();

/**
 * Image Verification Result
 */
export interface ImageVerificationResult {
  allowed: boolean;
  image: string;
  registry: string;
  reason: string;
  warnings: string[];
}

/**
 * Registry Configuration
 */
export interface RegistryConfig {
  host: string;
  trusted: boolean;
  requireSignature?: boolean;
  allowedNamespaces?: string[];
}

/**
 * Default trusted registries
 */
const DEFAULT_TRUSTED_REGISTRIES: RegistryConfig[] = [
  {
    host: 'docker.io',
    trusted: true,
    allowedNamespaces: ['library'], // Official images only
  },
  {
    host: 'gcr.io',
    trusted: true,
  },
  {
    host: 'ghcr.io',
    trusted: true,
  },
  {
    host: 'nvcr.io', // NVIDIA Container Registry
    trusted: true,
  },
  {
    host: 'quay.io',
    trusted: true,
  },
];

/**
 * Known malicious or risky image patterns
 */
const BLOCKED_PATTERNS = [
  /cryptominer/i,
  /xmrig/i,
  /monero/i,
  /coin.*mine/i,
  /hack(er)?/i,
  /pwn/i,
  /exploit/i,
  /malware/i,
  /trojan/i,
  /rootkit/i,
];

/**
 * Image Verifier - Validates container images before execution
 */
export class ImageVerifier {
  private registries: RegistryConfig[];
  private blockedPatterns: RegExp[];
  private allowUnknownRegistries: boolean;
  private blockedImages: Set<string> = new Set();

  constructor(options: {
    registries?: RegistryConfig[];
    additionalPatterns?: RegExp[];
    allowUnknownRegistries?: boolean;
  } = {}) {
    this.registries = options.registries ?? DEFAULT_TRUSTED_REGISTRIES;
    this.blockedPatterns = [...BLOCKED_PATTERNS, ...(options.additionalPatterns ?? [])];
    this.allowUnknownRegistries = options.allowUnknownRegistries ?? false;
  }

  /**
   * Verify an image before pulling/running
   */
  verify(imageName: string): ImageVerificationResult {
    const warnings: string[] = [];

    // Parse image name
    const parsed = this.parseImageName(imageName);

    log.debug({ image: imageName, parsed }, 'Verifying image');

    // Check if image is explicitly blocked
    if (this.blockedImages.has(imageName) || this.blockedImages.has(parsed.fullName)) {
      return {
        allowed: false,
        image: imageName,
        registry: parsed.registry,
        reason: 'Image is explicitly blocked',
        warnings,
      };
    }

    // Check for blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(imageName)) {
        return {
          allowed: false,
          image: imageName,
          registry: parsed.registry,
          reason: `Image name matches blocked pattern: ${pattern.toString()}`,
          warnings,
        };
      }
    }

    // Find registry configuration
    const registryConfig = this.registries.find(r => r.host === parsed.registry);

    // Unknown registry check
    if (!registryConfig) {
      if (this.allowUnknownRegistries) {
        warnings.push(`Image is from unknown registry: ${parsed.registry}`);
        return {
          allowed: true,
          image: imageName,
          registry: parsed.registry,
          reason: 'Allowed from unknown registry (policy permits)',
          warnings,
        };
      }
      return {
        allowed: false,
        image: imageName,
        registry: parsed.registry,
        reason: `Registry not in trusted list: ${parsed.registry}`,
        warnings,
      };
    }

    // Check if registry is trusted
    if (!registryConfig.trusted) {
      return {
        allowed: false,
        image: imageName,
        registry: parsed.registry,
        reason: `Registry is not trusted: ${parsed.registry}`,
        warnings,
      };
    }

    // Check namespace restrictions
    if (registryConfig.allowedNamespaces && registryConfig.allowedNamespaces.length > 0) {
      if (!registryConfig.allowedNamespaces.includes(parsed.namespace)) {
        return {
          allowed: false,
          image: imageName,
          registry: parsed.registry,
          reason: `Namespace '${parsed.namespace}' not allowed for registry '${parsed.registry}'`,
          warnings,
        };
      }
    }

    // Add warnings for potential issues
    if (!parsed.tag || parsed.tag === 'latest') {
      warnings.push('Image uses "latest" tag - consider using a specific version');
    }

    if (parsed.digest) {
      // Image pinned by digest - good practice
    } else {
      warnings.push('Image is not pinned by digest - vulnerable to tag mutation');
    }

    log.info({ image: imageName, registry: parsed.registry }, 'Image verified');

    return {
      allowed: true,
      image: imageName,
      registry: parsed.registry,
      reason: 'Image passed verification',
      warnings,
    };
  }

  /**
   * Parse image name into components
   */
  parseImageName(imageName: string): {
    registry: string;
    namespace: string;
    name: string;
    tag: string;
    digest: string | null;
    fullName: string;
  } {
    let registry = 'docker.io';
    let namespace = 'library';
    let name = imageName;
    let tag = 'latest';
    let digest: string | null = null;

    // Check for digest
    const digestIndex = name.indexOf('@');
    if (digestIndex !== -1) {
      digest = name.slice(digestIndex + 1);
      name = name.slice(0, digestIndex);
    }

    // Check for tag
    const tagIndex = name.indexOf(':');
    if (tagIndex !== -1) {
      tag = name.slice(tagIndex + 1);
      name = name.slice(0, tagIndex);
    }

    // Check for registry (contains . or :)
    const firstSlash = name.indexOf('/');
    if (firstSlash !== -1) {
      const potentialRegistry = name.slice(0, firstSlash);
      if (potentialRegistry.includes('.') || potentialRegistry.includes(':')) {
        registry = potentialRegistry;
        name = name.slice(firstSlash + 1);
      }
    }

    // Check for namespace
    const slashIndex = name.indexOf('/');
    if (slashIndex !== -1) {
      namespace = name.slice(0, slashIndex);
      name = name.slice(slashIndex + 1);
    }

    const fullName = `${registry}/${namespace}/${name}:${tag}`;

    return {
      registry,
      namespace,
      name,
      tag,
      digest,
      fullName,
    };
  }

  /**
   * Add a trusted registry
   */
  addTrustedRegistry(config: RegistryConfig): void {
    const existing = this.registries.findIndex(r => r.host === config.host);
    if (existing !== -1) {
      this.registries[existing] = config;
    } else {
      this.registries.push(config);
    }
    log.info({ registry: config.host }, 'Added trusted registry');
  }

  /**
   * Remove a trusted registry
   */
  removeTrustedRegistry(host: string): boolean {
    const index = this.registries.findIndex(r => r.host === host);
    if (index !== -1) {
      this.registries.splice(index, 1);
      log.info({ registry: host }, 'Removed trusted registry');
      return true;
    }
    return false;
  }

  /**
   * Block a specific image
   */
  blockImage(imageName: string): void {
    this.blockedImages.add(imageName);
    log.info({ image: imageName }, 'Blocked image');
  }

  /**
   * Unblock a specific image
   */
  unblockImage(imageName: string): boolean {
    const result = this.blockedImages.delete(imageName);
    if (result) {
      log.info({ image: imageName }, 'Unblocked image');
    }
    return result;
  }

  /**
   * Add a blocked pattern
   */
  addBlockedPattern(pattern: RegExp): void {
    this.blockedPatterns.push(pattern);
    log.info({ pattern: pattern.toString() }, 'Added blocked pattern');
  }

  /**
   * Get list of trusted registries
   */
  getTrustedRegistries(): RegistryConfig[] {
    return [...this.registries];
  }

  /**
   * Get list of blocked images
   */
  getBlockedImages(): string[] {
    return Array.from(this.blockedImages);
  }

  /**
   * Set whether to allow unknown registries
   */
  setAllowUnknownRegistries(allow: boolean): void {
    this.allowUnknownRegistries = allow;
    log.info({ allow }, 'Updated unknown registry policy');
  }

  /**
   * Check if unknown registries are allowed
   */
  isUnknownRegistriesAllowed(): boolean {
    return this.allowUnknownRegistries;
  }
}
