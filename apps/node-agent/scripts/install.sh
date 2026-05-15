#!/bin/bash
#
# A²E Node Agent Installation Script
#
# Usage: curl -sSL https://a2e-api.onrender.com/install.sh | bash
#    or: ./install.sh [options]
#
# Options:
#   --version VERSION    Install specific version (default: latest)
#   --dir DIR           Installation directory (default: /opt/a2e-agent)
#   --no-service        Don't install systemd service
#   --no-configure      Don't run configuration wizard
#   --uninstall         Remove existing installation
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DOWNLOAD_BASE_URL="${A2E_DOWNLOAD_URL:-https://a2e-api.onrender.com/releases}"
INSTALL_DIR="${A2E_INSTALL_DIR:-/opt/a2e-agent}"
CONFIG_DIR="${A2E_CONFIG_DIR:-/etc/a2e-agent}"
DATA_DIR="${A2E_DATA_DIR:-/var/lib/a2e-agent}"
LOG_DIR="${A2E_LOG_DIR:-/var/log/a2e-agent}"
VERSION="${A2E_VERSION:-latest}"
INSTALL_SERVICE=true
RUN_CONFIGURE=true
UNINSTALL=false

# Detect OS and architecture
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        *)       error "Unsupported operating system: $(uname -s)" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)  arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)             error "Unsupported architecture: $(uname -m)" ;;
    esac

    echo "${os}-${arch}"
}

# Logging functions
log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
    exit 1
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root. Use: sudo $0"
    fi
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."

    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Please install Docker first: https://docs.docker.com/engine/install/"
    fi

    # Check Docker is running
    if ! docker info &> /dev/null; then
        error "Docker daemon is not running. Please start Docker first."
    fi

    # Check for NVIDIA Docker runtime
    if ! docker info 2>/dev/null | grep -q "nvidia"; then
        warn "NVIDIA Docker runtime not detected. GPU support may not work."
        warn "Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
    fi

    # Check for NVIDIA drivers
    if command -v nvidia-smi &> /dev/null; then
        log "NVIDIA driver detected: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
    else
        warn "nvidia-smi not found. GPU support may not work."
    fi

    # Check curl or wget
    if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
        error "curl or wget is required. Please install one of them."
    fi

    # Check systemd (optional)
    if ! command -v systemctl &> /dev/null; then
        warn "systemd not found. Service management will not be available."
        INSTALL_SERVICE=false
    fi

    log "Prerequisites check passed"
}

# Download file with curl or wget
download() {
    local url="$1"
    local output="$2"

    if command -v curl &> /dev/null; then
        curl -fsSL "$url" -o "$output"
    elif command -v wget &> /dev/null; then
        wget -q "$url" -O "$output"
    else
        error "Neither curl nor wget available"
    fi
}

# Public GitHub URL for the repo we clone the agent source from. Override
# with A2E_REPO_URL if the repo is mirrored or forked. The default points
# at the upstream public repo so the curl|bash flow works out of the box.
REPO_URL="${A2E_REPO_URL:-https://github.com/StackMerth/a2e-neo-nodes.git}"
REPO_BRANCH="${A2E_REPO_BRANCH:-main}"
MIN_NODE_MAJOR=20

# Ensure Node 20+ is available. Installs via NodeSource on apt-based
# distros if missing; otherwise points the operator at nodejs.org. We
# need node at runtime to execute the built agent (no precompiled
# binary release yet — install-from-source).
ensure_node() {
    if command -v node &> /dev/null; then
        local node_major
        node_major=$(node -v | sed 's/v//' | cut -d. -f1)
        if [[ "$node_major" -ge "$MIN_NODE_MAJOR" ]]; then
            log "Node $(node -v) detected"
            return
        fi
        warn "Node $(node -v) is too old; need Node ${MIN_NODE_MAJOR}+"
    fi

    log "Installing Node ${MIN_NODE_MAJOR} LTS via NodeSource..."
    if ! command -v apt-get &> /dev/null; then
        error "Automatic Node install only supports apt-based distros (Ubuntu/Debian). Install Node ${MIN_NODE_MAJOR}+ manually from https://nodejs.org/ and re-run."
    fi
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
    log "Node $(node -v) installed"
}

# pnpm is what the monorepo uses; install globally via npm if missing.
# Pinning to v8 matches the version in package.json + render.yaml.
ensure_pnpm() {
    if command -v pnpm &> /dev/null; then
        log "pnpm $(pnpm -v) detected"
        return
    fi
    log "Installing pnpm@8 globally..."
    npm install -g pnpm@8
}

# Ensure git is available (needed for the source clone).
ensure_git() {
    if command -v git &> /dev/null; then return; fi
    log "Installing git..."
    if command -v apt-get &> /dev/null; then
        apt-get install -y git
    elif command -v yum &> /dev/null; then
        yum install -y git
    else
        error "git not found and no supported package manager. Install git manually and re-run."
    fi
}

# Clone the agent source + build it. Replaces the legacy precompiled
# binary download because we don't ship binary releases yet. The repo
# is cloned shallow (depth=1) for speed; updates are cheap with a
# subsequent `git pull` + rebuild.
install_from_source() {
    local platform
    platform=$(detect_platform)

    ensure_git
    ensure_node
    ensure_pnpm

    local repo_dir="$INSTALL_DIR/repo"
    if [[ -d "$repo_dir/.git" ]]; then
        log "Repo already cloned; pulling latest from ${REPO_BRANCH}..."
        (cd "$repo_dir" && git fetch --depth=1 origin "$REPO_BRANCH" && git reset --hard "origin/${REPO_BRANCH}")
    else
        log "Cloning ${REPO_URL} (branch ${REPO_BRANCH})..."
        mkdir -p "$INSTALL_DIR"
        git clone --depth=1 --branch "$REPO_BRANCH" "$REPO_URL" "$repo_dir"
    fi

    log "Installing workspace deps + building agent (this takes ~60-90s)..."
    (
        cd "$repo_dir"
        # --prod=false because we need devDependencies (typescript, prisma
        # CLI) to build. The agent's runtime deps will still be present.
        pnpm install --frozen-lockfile --prod=false
        # The ... filter pulls in shared workspace packages the agent needs.
        pnpm --filter "@a2e/node-agent..." build
    )

    # Wrapper script so the systemd unit ExecStart stays stable even if
    # we move the entry point later. The wrapper just execs node against
    # the built dist.
    mkdir -p "$INSTALL_DIR/bin"
    cat > "$INSTALL_DIR/bin/a2e-agent" << 'EOF'
#!/usr/bin/env bash
exec node /opt/a2e-agent/repo/apps/node-agent/dist/index.js "$@"
EOF
    chmod +x "$INSTALL_DIR/bin/a2e-agent"

    # Convenience symlink so operators can run `a2e-agent` from any cwd.
    ln -sf "$INSTALL_DIR/bin/a2e-agent" /usr/local/bin/a2e-agent

    log "Agent installed from source. Platform: ${platform}"
}

# Create required directories
create_directories() {
    log "Creating directories..."

    mkdir -p "$CONFIG_DIR"
    mkdir -p "$DATA_DIR"
    mkdir -p "$LOG_DIR"

    # Set permissions
    chmod 700 "$CONFIG_DIR"
    chmod 755 "$DATA_DIR"
    chmod 755 "$LOG_DIR"

    log "Directories created"
}

# Install systemd service
install_service() {
    if [[ "$INSTALL_SERVICE" != "true" ]]; then
        return
    fi

    log "Installing systemd service..."

    cat > /etc/systemd/system/a2e-agent.service << 'EOF'
[Unit]
Description=A²E Node Agent
Documentation=https://a2e-api.onrender.com/docs
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
Group=root
ExecStart=/opt/a2e-agent/bin/a2e-agent --config /etc/a2e-agent/agent.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=a2e-agent

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/a2e-agent /var/log/a2e-agent

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd
    systemctl daemon-reload

    # Enable service
    systemctl enable a2e-agent

    log "Systemd service installed and enabled"
}

# Run configuration wizard
run_configure() {
    if [[ "$RUN_CONFIGURE" != "true" ]]; then
        return
    fi

    log "Running configuration wizard..."

    # Check if config already exists
    if [[ -f "$CONFIG_DIR/agent.yaml" ]]; then
        echo -e "${YELLOW}Configuration file already exists at $CONFIG_DIR/agent.yaml${NC}"
        # Token mode: never prompt. Just overwrite the config; the new
        # token claim supersedes whatever was there.
        if [[ -z "${INSTALL_TOKEN:-}" ]]; then
            read -p "Do you want to reconfigure? [y/N] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                return
            fi
        fi
    fi

    # Non-interactive token mode (launch-blocker #1 — BYOG curl|bash).
    # Triggered by the install endpoint exporting INSTALL_TOKEN before
    # running this script. Skips the interactive wizard and the
    # `a2e-agent configure` subcommand entirely.
    if [[ -n "${INSTALL_TOKEN:-}" ]]; then
        configure_with_token
        return
    fi

    # Run the configure script
    if [[ -x "$INSTALL_DIR/bin/a2e-agent" ]]; then
        "$INSTALL_DIR/bin/a2e-agent" configure --output "$CONFIG_DIR/agent.yaml"
    else
        # Fallback to interactive prompts
        configure_interactive
    fi
}

# Extract a top-level string field from a flat JSON blob without
# depending on jq/python3. Handles {"key":"value"} with either spaces or
# no spaces around the colon. Returns empty string on miss.
json_field() {
    local field="$1"
    local body="$2"
    echo "$body" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
        | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' \
        | head -n 1
}

# Non-interactive configuration triggered when INSTALL_TOKEN is set
# (the curl|bash flow from the operator portal). Detects GPU + system
# specs, POSTs them along with the install token to /v1/byog/claim,
# parses the returned credentials, and writes agent.yaml.
configure_with_token() {
    local api_url="${A2E_API_URL:-https://a2e-api.onrender.com}"
    local region="${A2E_REGION:-}"

    log "Non-interactive install (token mode), claiming node against ${api_url}..."

    # Detect GPU tier from nvidia-smi.
    local gpu_tier="OTHER"
    local gpu_model=""
    local gpu_count=0
    local gpu_vram=0
    local gpu_driver=""
    if command -v nvidia-smi &> /dev/null; then
        gpu_model=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | xargs)
        gpu_count=$(nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1 | xargs)
        gpu_vram=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | xargs)
        gpu_driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | xargs)
        case "$gpu_model" in
            *H100*)  gpu_tier="H100" ;;
            *H200*)  gpu_tier="H200" ;;
            *B200*)  gpu_tier="B200" ;;
            *B300*)  gpu_tier="B300" ;;
            *GB300*) gpu_tier="GB300" ;;
        esac
    fi

    # CUDA version (from nvcc if installed, else from nvidia-smi).
    local cuda_version=""
    if command -v nvcc &> /dev/null; then
        cuda_version=$(nvcc --version 2>/dev/null | grep -oE 'release [0-9]+\.[0-9]+' | awk '{print $2}')
    fi
    if [[ -z "$cuda_version" ]] && command -v nvidia-smi &> /dev/null; then
        cuda_version=$(nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' | awk '{print $3}' | head -1)
    fi

    local hostname_val os_val os_version_val total_memory_mb disk_avail_gb total_cpus docker_version
    hostname_val=$(hostname 2>/dev/null || echo "unknown")
    os_val=$(uname -s 2>/dev/null || echo "unknown")
    os_version_val=$(uname -r 2>/dev/null || echo "unknown")
    total_memory_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    disk_avail_gb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -d 'G ' || echo 0)
    total_cpus=$(nproc 2>/dev/null || echo 0)
    docker_version=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || echo "")
    local agent_version="${VERSION}"

    log "Detected: ${gpu_count}x ${gpu_model:-unknown GPU} (${gpu_tier}, ${gpu_vram}MB VRAM, driver ${gpu_driver:-?})"
    [[ -n "$cuda_version" ]] && log "CUDA: ${cuda_version}"

    # Build the JSON payload. Numbers are unquoted; strings quoted. We
    # only include optional fields when they have a non-empty value to
    # keep the payload tidy on the wire.
    local payload
    payload=$(cat <<EOF
{
  "installToken": "${INSTALL_TOKEN}",
  "specs": {
    "gpuTier": "${gpu_tier}",
    "gpuModel": "${gpu_model}",
    "gpuCount": ${gpu_count:-0},
    "gpuVram": ${gpu_vram:-0},
    "gpuDriver": "${gpu_driver}",
    "cudaVersion": "${cuda_version}",
    "hostname": "${hostname_val}",
    "os": "${os_val}",
    "osVersion": "${os_version_val}",
    "totalMemory": ${total_memory_mb:-0},
    "diskAvailable": ${disk_avail_gb:-0},
    "totalCpus": ${total_cpus:-0},
    "dockerVersion": "${docker_version}",
    "agentVersion": "${agent_version}"
  }
}
EOF
)

    local response http_code
    response=$(curl -fsS -w "\n%{http_code}" \
        -H "Content-Type: application/json" \
        -X POST \
        --data "${payload}" \
        "${api_url}/v1/byog/claim" 2>&1) || {
        error "Claim request to ${api_url}/v1/byog/claim failed: ${response}"
    }
    http_code=$(echo "$response" | tail -n 1)
    local body
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" != "201" && "$http_code" != "200" ]]; then
        error "Claim returned HTTP ${http_code}: ${body}"
    fi

    local node_id node_api_key node_region
    node_id=$(json_field "nodeId" "$body")
    node_api_key=$(json_field "apiKey" "$body")
    node_region=$(json_field "region" "$body")

    if [[ -z "$node_id" || -z "$node_api_key" ]]; then
        error "Claim response missing nodeId or apiKey: ${body}"
    fi

    log "Node claimed: ${node_id} (region: ${node_region:-unspecified})"

    cat > "$CONFIG_DIR/agent.yaml" << EOF
# A²E Node Agent Configuration
# Generated by install.sh (BYOG token mode) on $(date -Iseconds)

server:
  apiUrl: ${api_url}
  apiKey: ${node_api_key}

node:
  id: ${node_id}
  name: ${hostname_val}
  gpuTier: ${gpu_tier}
  region: ${node_region}

docker:
  socketPath: /var/run/docker.sock
  gpuRuntime: nvidia

heartbeat:
  intervalSeconds: 30

logging:
  level: info
  pretty: false

security:
  sandboxProfile: standard
  trustedRegistries:
    - docker.io
    - nvcr.io
    - gcr.io
EOF

    chmod 600 "$CONFIG_DIR/agent.yaml"
    log "Configuration saved to $CONFIG_DIR/agent.yaml"
}

# Interactive configuration (fallback)
configure_interactive() {
    echo ""
    echo -e "${BLUE}=== A²E Agent Configuration ===${NC}"
    echo ""

    # API URL
    read -p "A²E API URL [https://a2e-api.onrender.com]: " api_url
    api_url="${api_url:-https://a2e-api.onrender.com}"

    # API Key
    read -p "API Key: " api_key
    if [[ -z "$api_key" ]]; then
        error "API key is required"
    fi

    # Node name
    local default_name
    default_name=$(hostname)
    read -p "Node name [$default_name]: " node_name
    node_name="${node_name:-$default_name}"

    # Detect GPU
    local gpu_tier="UNKNOWN"
    if command -v nvidia-smi &> /dev/null; then
        local gpu_name
        gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
        log "Detected GPU: $gpu_name"

        case "$gpu_name" in
            *H100*) gpu_tier="H100" ;;
            *H200*) gpu_tier="H200" ;;
            *B200*) gpu_tier="B200" ;;
            *B300*) gpu_tier="B300" ;;
            *GB300*) gpu_tier="GB300" ;;
            *A100*) gpu_tier="A100" ;;
            *) gpu_tier="OTHER" ;;
        esac
    fi

    read -p "GPU Tier [$gpu_tier]: " input_tier
    gpu_tier="${input_tier:-$gpu_tier}"

    # Write config file
    cat > "$CONFIG_DIR/agent.yaml" << EOF
# A²E Node Agent Configuration
# Generated by install.sh on $(date -Iseconds)

server:
  apiUrl: ${api_url}
  apiKey: ${api_key}

node:
  name: ${node_name}
  gpuTier: ${gpu_tier}

docker:
  socketPath: /var/run/docker.sock
  gpuRuntime: nvidia

heartbeat:
  intervalSeconds: 30

logging:
  level: info
  pretty: false

security:
  sandboxProfile: standard
  trustedRegistries:
    - docker.io
    - nvcr.io
    - gcr.io
EOF

    chmod 600 "$CONFIG_DIR/agent.yaml"
    log "Configuration saved to $CONFIG_DIR/agent.yaml"
}

# Uninstall
uninstall() {
    log "Uninstalling A²E Agent..."

    # Stop and disable service
    if systemctl is-active --quiet a2e-agent 2>/dev/null; then
        systemctl stop a2e-agent
    fi
    if systemctl is-enabled --quiet a2e-agent 2>/dev/null; then
        systemctl disable a2e-agent
    fi

    # Remove service file
    rm -f /etc/systemd/system/a2e-agent.service
    systemctl daemon-reload 2>/dev/null || true

    # Remove binary
    rm -f /usr/local/bin/a2e-agent
    rm -rf "$INSTALL_DIR"

    # Ask about config and data
    read -p "Remove configuration files? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$CONFIG_DIR"
        log "Configuration removed"
    fi

    read -p "Remove data files? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$DATA_DIR"
        log "Data removed"
    fi

    read -p "Remove log files? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$LOG_DIR"
        log "Logs removed"
    fi

    log "Uninstallation complete"
}

# Parse arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --version)
                VERSION="$2"
                shift 2
                ;;
            --dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --no-service)
                INSTALL_SERVICE=false
                shift
                ;;
            --no-configure)
                RUN_CONFIGURE=false
                shift
                ;;
            --uninstall)
                UNINSTALL=true
                shift
                ;;
            -h|--help)
                cat << EOF
A²E Node Agent Installation Script

Usage: $0 [options]

Options:
  --version VERSION    Install specific version (default: latest)
  --dir DIR           Installation directory (default: /opt/a2e-agent)
  --no-service        Don't install systemd service
  --no-configure      Don't run configuration wizard
  --uninstall         Remove existing installation
  -h, --help          Show this help message

Environment Variables:
  A2E_DOWNLOAD_URL    Base URL for downloads
  A2E_INSTALL_DIR     Installation directory
  A2E_CONFIG_DIR      Configuration directory
  A2E_DATA_DIR        Data directory
  A2E_LOG_DIR         Log directory
  A2E_VERSION         Version to install

EOF
                exit 0
                ;;
            *)
                error "Unknown option: $1"
                ;;
        esac
    done
}

# Main
main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     A²E Node Agent Installer          ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
    echo ""

    parse_args "$@"
    check_root

    if [[ "$UNINSTALL" == "true" ]]; then
        uninstall
        exit 0
    fi

    check_prerequisites
    install_from_source
    create_directories
    install_service
    run_configure

    # Token-mode auto-start: the config is fully populated, no human
    # intervention needed before bringing the agent online.
    if [[ -n "${INSTALL_TOKEN:-}" && "$INSTALL_SERVICE" == "true" ]] \
        && command -v systemctl &> /dev/null; then
        log "Starting a2e-agent service..."
        systemctl start a2e-agent || warn "Failed to start a2e-agent; check journalctl -u a2e-agent"
    fi

    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Installation Complete!            ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    if [[ -n "${INSTALL_TOKEN:-}" ]]; then
        echo "Node is online. The portal will show your first heartbeat within ~30s."
        echo ""
        echo "Useful commands:"
        echo "  - Status:  systemctl status a2e-agent"
        echo "  - Logs:    journalctl -u a2e-agent -f"
        echo "  - Config:  $CONFIG_DIR/agent.yaml"
        echo ""
    else
        echo "Next steps:"
        echo "  1. Review configuration: $CONFIG_DIR/agent.yaml"
        echo "  2. Start the agent: systemctl start a2e-agent"
        echo "  3. Check status: systemctl status a2e-agent"
        echo "  4. View logs: journalctl -u a2e-agent -f"
        echo ""
    fi
}

main "$@"
