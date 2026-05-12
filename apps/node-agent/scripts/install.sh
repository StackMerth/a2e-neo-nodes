#!/bin/bash
#
# A²E Node Agent Installation Script
#
# Usage: curl -sSL https://tokenosdeai-api.onrender.com/install.sh | bash
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
DOWNLOAD_BASE_URL="${A2E_DOWNLOAD_URL:-https://tokenosdeai-api.onrender.com/releases}"
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

# Get latest version
get_latest_version() {
    local version_url="${DOWNLOAD_BASE_URL}/latest/version"
    local version

    if command -v curl &> /dev/null; then
        version=$(curl -fsSL "$version_url" 2>/dev/null || echo "")
    else
        version=$(wget -qO- "$version_url" 2>/dev/null || echo "")
    fi

    if [[ -z "$version" ]]; then
        error "Failed to fetch latest version. Check your network connection."
    fi

    echo "$version"
}

# Download and install binary
install_binary() {
    local platform version binary_url checksum_url
    platform=$(detect_platform)

    if [[ "$VERSION" == "latest" ]]; then
        version=$(get_latest_version)
        log "Latest version: $version"
    else
        version="$VERSION"
    fi

    binary_url="${DOWNLOAD_BASE_URL}/${version}/a2e-agent-${platform}"
    checksum_url="${DOWNLOAD_BASE_URL}/${version}/checksums.txt"

    log "Downloading A²E Agent ${version} for ${platform}..."

    # Create temp directory
    local temp_dir
    temp_dir=$(mktemp -d)
    trap "rm -rf $temp_dir" EXIT

    # Download binary
    download "$binary_url" "$temp_dir/a2e-agent"

    # Download and verify checksum
    log "Verifying checksum..."
    download "$checksum_url" "$temp_dir/checksums.txt"

    local expected_checksum actual_checksum
    expected_checksum=$(grep "a2e-agent-${platform}" "$temp_dir/checksums.txt" | awk '{print $1}')
    actual_checksum=$(sha256sum "$temp_dir/a2e-agent" | awk '{print $1}')

    if [[ "$expected_checksum" != "$actual_checksum" ]]; then
        error "Checksum verification failed! Expected: $expected_checksum, Got: $actual_checksum"
    fi

    log "Checksum verified"

    # Create installation directory
    mkdir -p "$INSTALL_DIR/bin"

    # Install binary
    install -m 755 "$temp_dir/a2e-agent" "$INSTALL_DIR/bin/a2e-agent"

    # Create symlink
    ln -sf "$INSTALL_DIR/bin/a2e-agent" /usr/local/bin/a2e-agent

    log "Binary installed to $INSTALL_DIR/bin/a2e-agent"
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
Documentation=https://tokenosdeai-api.onrender.com/docs
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
        read -p "Do you want to reconfigure? [y/N] " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return
        fi
    fi

    # Run the configure script
    if [[ -x "$INSTALL_DIR/bin/a2e-agent" ]]; then
        "$INSTALL_DIR/bin/a2e-agent" configure --output "$CONFIG_DIR/agent.yaml"
    else
        # Fallback to interactive prompts
        configure_interactive
    fi
}

# Interactive configuration (fallback)
configure_interactive() {
    echo ""
    echo -e "${BLUE}=== A²E Agent Configuration ===${NC}"
    echo ""

    # API URL
    read -p "A²E API URL [https://tokenosdeai-api.onrender.com]: " api_url
    api_url="${api_url:-https://tokenosdeai-api.onrender.com}"

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
    install_binary
    create_directories
    install_service
    run_configure

    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║     Installation Complete!            ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Review configuration: $CONFIG_DIR/agent.yaml"
    echo "  2. Start the agent: systemctl start a2e-agent"
    echo "  3. Check status: systemctl status a2e-agent"
    echo "  4. View logs: journalctl -u a2e-agent -f"
    echo ""
}

main "$@"
