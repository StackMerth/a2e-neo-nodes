# E6 / M3.8c: Generate the RSA keypair + X.509 cert for the Docker
# Image Registry token auth.
#
# Output files (created in the current working directory):
#
#   registry-private.pem   PEM-encoded RSA 4096-bit private key.
#                          Goes into the a2e-api Render env var
#                          REGISTRY_JWT_PRIVATE_KEY (with literal
#                          newlines replaced by \n since Render
#                          env vars are single-line).
#
#   registry-public.pem    PEM-encoded RSA public key. Not directly
#                          used (the registry consumes the cert below)
#                          but kept for reference.
#
#   registry-cert.pem      Self-signed X.509 cert containing the
#                          public key. Goes onto the a2e-registry
#                          Render service as a Secret File mounted
#                          at /etc/docker/registry/cert.pem
#                          (the path REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE
#                          points to).
#
# Prerequisites:
#   - openssl on PATH. Most Windows dev environments have it via
#     Git for Windows; check with `openssl version`. If missing,
#     install via Chocolatey: `choco install openssl` or download
#     from https://slproweb.com/products/Win32OpenSSL.html
#
# Security:
#   - Run this in a temp directory you trust. Anyone with the
#     private.pem can sign tokens that grant arbitrary registry
#     access to your buyers' namespaces.
#   - Add *.pem to .gitignore (already done in the repo root).
#   - Delete the local copies after pasting into Render env / Secret
#     Files. The Render dashboard is the only persistent home.

Write-Host "=== Generating RSA 4096 private key ==="
openssl genrsa -out registry-private.pem 4096
if ($LASTEXITCODE -ne 0) { Write-Error "openssl genrsa failed"; exit 1 }

Write-Host ""
Write-Host "=== Deriving public key ==="
openssl rsa -in registry-private.pem -pubout -out registry-public.pem
if ($LASTEXITCODE -ne 0) { Write-Error "openssl rsa pubout failed"; exit 1 }

Write-Host ""
Write-Host "=== Generating self-signed X.509 cert (CN=a2e-registry-issuer, 10 year validity) ==="
openssl req -x509 -new -key registry-private.pem -days 3650 `
    -subj "/CN=a2e-registry-issuer" `
    -out registry-cert.pem
if ($LASTEXITCODE -ne 0) { Write-Error "openssl req failed"; exit 1 }

Write-Host ""
Write-Host "=== Output files ==="
Get-ChildItem registry-*.pem | ForEach-Object { Write-Host "  $($_.Name) ($($_.Length) bytes)" }

Write-Host ""
Write-Host "=== Render env var format (private key, for REGISTRY_JWT_PRIVATE_KEY) ==="
Write-Host "Copy the SINGLE LINE below into Render's env var editor (it has literal '\\n' instead of newlines):"
Write-Host ""
(Get-Content registry-private.pem -Raw) -replace "`r`n", '\n' -replace "`n", '\n'

Write-Host ""
Write-Host "=== Next steps (M3.8c runbook) ==="
Write-Host "  1. Paste the single-line private key above into the Render dashboard"
Write-Host "     a2e-api service -> Environment -> REGISTRY_JWT_PRIVATE_KEY"
Write-Host "  2. Upload registry-cert.pem as a Render Secret File on the"
Write-Host "     a2e-registry service, mount path = /etc/docker/registry/cert.pem"
Write-Host "  3. Set the S3 env vars on a2e-registry (see docs/E6_M3_8C_RUNBOOK.md)"
Write-Host "  4. Sync the Blueprint to provision the new a2e-registry service"
Write-Host "  5. Run the end-to-end docker push test from the runbook"
Write-Host ""
Write-Host "  After everything is verified, DELETE the local .pem files."
