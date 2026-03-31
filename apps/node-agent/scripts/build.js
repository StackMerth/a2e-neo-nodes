#!/usr/bin/env node
/**
 * A²E Node Agent Build Script
 *
 * Usage:
 *   node build.js              - Build bundle only
 *   node build.js --release    - Build release binaries
 *   node build.js --checksum   - Generate checksums
 */

const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BIN_DIR = path.join(DIST_DIR, 'bin');
const RELEASE_DIR = path.join(DIST_DIR, 'release');

// Package version
const pkg = require(path.join(ROOT_DIR, 'package.json'));
const VERSION = pkg.version;

// Build targets
const TARGETS = [
  { platform: 'linux', arch: 'x64', pkgTarget: 'node18-linux-x64' },
  { platform: 'linux', arch: 'arm64', pkgTarget: 'node18-linux-arm64' },
  // { platform: 'darwin', arch: 'x64', pkgTarget: 'node18-macos-x64' },
  // { platform: 'darwin', arch: 'arm64', pkgTarget: 'node18-macos-arm64' },
];

/**
 * Clean build directories
 */
function clean() {
  console.log('Cleaning build directories...');
  if (fs.existsSync(BIN_DIR)) {
    fs.rmSync(BIN_DIR, { recursive: true });
  }
  if (fs.existsSync(RELEASE_DIR)) {
    fs.rmSync(RELEASE_DIR, { recursive: true });
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
}

/**
 * Bundle with esbuild
 */
async function bundle() {
  console.log('Bundling with esbuild...');

  await esbuild.build({
    entryPoints: [path.join(DIST_DIR, 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: path.join(DIST_DIR, 'bundle.js'),
    external: [
      // Only truly native modules that can't be bundled
      // pino and pino-pretty are pure JS, so they can be bundled
    ],
    minify: process.env.NODE_ENV === 'production',
    sourcemap: false,
    define: {
      'process.env.AGENT_VERSION': JSON.stringify(VERSION),
    },
  });

  console.log('Bundle created: dist/bundle.js');
}

/**
 * Build binary for a specific target
 */
function buildBinary(target) {
  const { platform, arch, pkgTarget } = target;
  const outputName = `a2e-agent-${platform}-${arch}`;
  const outputPath = path.join(BIN_DIR, outputName);

  console.log(`Building binary for ${platform}-${arch}...`);

  try {
    execSync(
      `npx pkg ${path.join(DIST_DIR, 'bundle.js')} ` +
      `--target ${pkgTarget} ` +
      `--output ${outputPath} ` +
      `--compress GZip`,
      { stdio: 'inherit', cwd: ROOT_DIR }
    );

    // Make executable
    if (platform !== 'win32') {
      fs.chmodSync(outputPath, 0o755);
    }

    console.log(`Binary created: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error(`Failed to build for ${platform}-${arch}:`, error.message);
    return null;
  }
}

/**
 * Generate SHA256 checksum for a file
 */
function generateChecksum(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Create release artifacts
 */
async function createRelease() {
  console.log(`\nCreating release v${VERSION}...`);

  clean();
  await bundle();

  const checksums = [];
  const versionDir = path.join(RELEASE_DIR, VERSION);
  fs.mkdirSync(versionDir, { recursive: true });

  for (const target of TARGETS) {
    const binaryPath = buildBinary(target);
    if (binaryPath && fs.existsSync(binaryPath)) {
      // Copy to release directory
      const fileName = path.basename(binaryPath);
      const releasePath = path.join(versionDir, fileName);
      fs.copyFileSync(binaryPath, releasePath);

      // Generate checksum
      const checksum = generateChecksum(releasePath);
      checksums.push(`${checksum}  ${fileName}`);

      console.log(`  ${fileName}: ${checksum.slice(0, 16)}...`);
    }
  }

  // Write checksums file
  const checksumsPath = path.join(versionDir, 'checksums.txt');
  fs.writeFileSync(checksumsPath, checksums.join('\n') + '\n');
  console.log(`\nChecksums written to: ${checksumsPath}`);

  // Write version file
  const versionPath = path.join(versionDir, 'version');
  fs.writeFileSync(versionPath, VERSION);

  // Create latest symlink
  const latestDir = path.join(RELEASE_DIR, 'latest');
  if (fs.existsSync(latestDir)) {
    fs.rmSync(latestDir, { recursive: true });
  }
  fs.cpSync(versionDir, latestDir, { recursive: true });

  console.log(`\nRelease v${VERSION} created in: ${versionDir}`);
}

/**
 * Quick build (bundle only)
 */
async function quickBuild() {
  await bundle();
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes('--release')) {
      await createRelease();
    } else if (args.includes('--checksum')) {
      // Generate checksums for existing binaries
      const files = fs.readdirSync(BIN_DIR).filter(f => f.startsWith('a2e-agent-'));
      for (const file of files) {
        const filePath = path.join(BIN_DIR, file);
        const checksum = generateChecksum(filePath);
        console.log(`${checksum}  ${file}`);
      }
    } else {
      await quickBuild();
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

main();
