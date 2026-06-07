#!/bin/bash
# Tenant-isolation validation for new rental SSH sessions.
#
# Paste this entire script into a fresh SSH session immediately after
# connecting to a new rental. It checks for residual data the previous
# tenant should not have left behind. If our post-provision cleanup
# (apps/api/src/services/inbound/tenant-cleanup.ts) is working, ALL
# checks should report "clean".
#
# Use this as the standard validation alongside nvidia-smi when
# testing ANY new provider rental: Lambda, RunPod, io.net, Phala,
# VoltageGPU, Vast.ai. A "DIRTY" finding on any provider means we
# need to investigate that provider's tenant boundary.
#
# To use on the rental:
#   curl -fsSL https://raw.githubusercontent.com/StackMerth/a2e-neo-nodes/main/apps/api/scripts/tenant-isolation-checks.sh | bash
# OR copy/paste the contents directly into the SSH session.

set -u
RED=$'\e[31m'
GREEN=$'\e[32m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

pass()  { printf '%s[PASS]%s %s\n' "$GREEN" "$RESET" "$1"; }
fail()  { printf '%s[FAIL]%s %s\n' "$RED" "$RESET" "$1"; }
warn()  { printf '%s[WARN]%s %s\n' "$YELLOW" "$RESET" "$1"; }

echo "==> Tenant isolation checks"
echo ""

# 1. last(1) — should show only current session
echo "--- Recent logins ---"
LAST_OUTPUT=$(last -n 5 2>/dev/null | head -n 10)
if [ -z "$LAST_OUTPUT" ] || ! echo "$LAST_OUTPUT" | grep -q "still logged in\|pts\|tty"; then
  warn "last command produced no usable output; cannot verify"
else
  echo "$LAST_OUTPUT"
  # Count entries that aren't the current session (status not "still logged in")
  STALE_LOGINS=$(echo "$LAST_OUTPUT" | grep -vE "still logged in|^reboot|^wtmp|^$" | wc -l)
  if [ "$STALE_LOGINS" -eq 0 ]; then
    pass "no prior tenant login records visible"
  else
    fail "$STALE_LOGINS prior login record(s) visible from previous tenants"
  fi
fi
echo ""

# 2. Shell history file size
echo "--- Shell history ---"
for f in ~/.bash_history ~/.zsh_history ~/.python_history ~/.mysql_history ~/.psql_history; do
  if [ -s "$f" ]; then
    LINES=$(wc -l < "$f" 2>/dev/null || echo 0)
    fail "$(basename "$f") has $LINES line(s) of prior content"
  fi
done
if ! ls -la ~/.bash_history ~/.zsh_history ~/.python_history 2>/dev/null | grep -q ' [1-9]'; then
  pass "shell history files are empty or missing"
fi
echo ""

# 3. Cloud / dev credentials
echo "--- Cloud credentials ---"
DIRTY_CREDS=0
for d in ~/.aws ~/.gcp ~/.azure ~/.docker ~/.kube ~/.gnupg ~/.config/gcloud; do
  if [ -e "$d" ] && [ "$(ls -A "$d" 2>/dev/null)" ]; then
    fail "$d exists with prior tenant content"
    DIRTY_CREDS=$((DIRTY_CREDS + 1))
  fi
done
if [ "$DIRTY_CREDS" -eq 0 ]; then
  pass "no cloud / dev credential dirs left behind"
fi
echo ""

# 4. Editor / IDE state
echo "--- Editor state ---"
DIRTY_IDE=0
for d in ~/.vscode-server ~/.cursor-server ~/.vscode-remote; do
  if [ -e "$d" ]; then
    fail "$d exists from prior tenant"
    DIRTY_IDE=$((DIRTY_IDE + 1))
  fi
done
if [ "$DIRTY_IDE" -eq 0 ]; then
  pass "no editor remote-server state left behind"
fi
echo ""

# 5. Tool config files that may carry identity
echo "--- Tool identity ---"
DIRTY_CFG=0
for f in ~/.gitconfig ~/.git-credentials ~/.npmrc ~/.netrc ~/.pypirc; do
  if [ -s "$f" ]; then
    fail "$f has content (likely prior tenant identity / credentials)"
    DIRTY_CFG=$((DIRTY_CFG + 1))
  fi
done
if [ "$DIRTY_CFG" -eq 0 ]; then
  pass "no identity-carrying tool config files left behind"
fi
echo ""

# 6. Tmp dirs
echo "--- /tmp ---"
TMP_COUNT=$(find /tmp -mindepth 1 -maxdepth 2 -not -path '/tmp/systemd-*' -not -path '/tmp/.X*' 2>/dev/null | wc -l)
if [ "$TMP_COUNT" -gt 0 ]; then
  warn "$TMP_COUNT non-system entries in /tmp (some may be image defaults)"
  find /tmp -mindepth 1 -maxdepth 2 -not -path '/tmp/systemd-*' -not -path '/tmp/.X*' 2>/dev/null | head -n 5
else
  pass "/tmp is clean"
fi
echo ""

echo "==> Done."
echo "If any FAIL above, provider tenant isolation is broken; report the"
echo "provider + rental id to the operator. The post-provision cleanup"
echo "service (tenant-cleanup.ts) should have wiped these before SSH"
echo "credentials surfaced."
