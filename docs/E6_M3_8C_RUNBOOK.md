# E6 / M3.8c — Docker Registry Deployment Runbook

Step-by-step playbook to bring the Docker Image Registry online on
Render and verify the end-to-end push flow. Estimated time: ~2 hours
the first time, ~30 min on a redo.

**Prerequisites:**
- openssl on PATH (check with `openssl version` in PowerShell)
- Docker Desktop installed locally (for the end-to-end test)
- AWS account with permissions to create an S3 bucket (or use an
  existing dedicated bucket for the registry)
- Access to the Render dashboard
- Access to your DNS provider (Vercel, Cloudflare, etc.)

---

## Step 1 — Generate the RSA keypair locally (5 min)

**Runtime: local PowerShell, in a temp directory you trust.**

```powershell
# Create + cd into a temp dir so the .pem files don't end up in the
# repo by accident.
New-Item -ItemType Directory -Force -Path "$env:TEMP\a2e-registry-keys" | Out-Null
cd "$env:TEMP\a2e-registry-keys"

# Run the script from the repo:
& "C:\Users\XPS\Documents\Vs Code Projects\a2e engine\a2e-engine\scripts\generate-registry-keypair.ps1"
```

The script outputs three files:
- `registry-private.pem` — RSA private key (KEEP SECRET)
- `registry-public.pem` — RSA public key (informational)
- `registry-cert.pem` — X.509 cert (goes on the registry service)

It also prints a single-line version of the private key formatted for
Render's env var editor. **Keep that PowerShell window open** — you'll
paste that string into Render in Step 3.

---

## Step 2 — Create the dedicated S3 bucket (10 min)

You can use AWS Console, the existing TokenOS AWS account, or any
S3-compatible store (DigitalOcean Spaces, Cloudflare R2 with API
shim, etc.). The registry just needs read+write+list on a bucket.

**Recommended setup:**
- Bucket name: `a2e-registry-prod` (or whatever your naming conv is)
- Region: `us-east-1` (or wherever your other infra lives)
- Versioning: OFF (registry handles its own content-addressing)
- Encryption: SSE-S3 default
- Public access: BLOCKED (registry uses pre-signed URLs internally)
- Lifecycle rule (optional): archive uploads older than 90 days to
  Glacier if you want to save on storage cost

**Create an IAM user with this minimal policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:ListBucket", "s3:GetBucketLocation",
      "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
      "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
    ],
    "Resource": ["arn:aws:s3:::a2e-registry-prod", "arn:aws:s3:::a2e-registry-prod/*"]
  }]
}
```

Save the IAM user's `Access Key ID` and `Secret Access Key` — you'll
paste them in Step 3.

---

## Step 3 — Set env vars on the a2e-api service (5 min)

**Runtime: Render dashboard.**

Go to **a2e-api → Environment**. Set:

| Env var | Value |
|---|---|
| `REGISTRY_JWT_PRIVATE_KEY` | The single-line private key string from Step 1 (literal `\n` instead of newlines) |
| `REGISTRY_SERVICE_NAME` | `a2e-registry` (default already set in Blueprint) |
| `REGISTRY_ISSUER` | `a2e-registry-issuer` (default already set in Blueprint) |
| `REGISTRY_WEBHOOK_SECRET` | A random 64-char string for webhook auth (generate any way you like) |

Click **Save Changes**. Render rebuilds in ~5 min. While that's
happening, move to Step 4.

---

## Step 4 — Apply the Blueprint to provision the a2e-registry service (15 min)

**Runtime: Render dashboard → Blueprints.**

The Blueprint (`render.yaml` in the repo root) now defines a new
service `a2e-registry`. Render's Blueprint sync will detect the new
service and prompt you to create it.

1. Open **Blueprints** in the Render sidebar
2. Find your existing TokenOS Blueprint, click **Sync**
3. Render shows a diff — confirm a new `a2e-registry` web service is
   about to be created
4. Click **Apply**. Render starts the first build.

The first build will **fail** because:
- `REGISTRY_STORAGE_S3_*` env vars aren't set yet (they're `sync: false`)
- The cert.pem Secret File isn't uploaded yet

That's expected. Continue to Step 5.

---

## Step 5 — Set env vars + upload cert on a2e-registry (5 min)

**Runtime: Render dashboard → a2e-registry → Environment.**

Set all four S3 vars from Step 2:

| Env var | Value |
|---|---|
| `REGISTRY_STORAGE_S3_BUCKET` | `a2e-registry-prod` (your bucket name) |
| `REGISTRY_STORAGE_S3_REGION` | `us-east-1` (your bucket region) |
| `REGISTRY_STORAGE_S3_ACCESSKEY` | IAM user access key id from Step 2 |
| `REGISTRY_STORAGE_S3_SECRETKEY` | IAM user secret access key from Step 2 |
| `REGISTRY_WEBHOOK_SECRET` | Same value you set on a2e-api in Step 3 |

Save Changes.

**Then go to Secret Files** (same service, sidebar):

- **Filename:** `cert.pem`
- **Mount path:** `/etc/docker/registry/cert.pem`
- **File contents:** paste the contents of `registry-cert.pem` from Step 1

Save Changes. Render redeploys the service. It should boot cleanly
this time. Watch logs for `listening on [::]:5000` — that means the
registry is up.

---

## Step 6 — Configure DNS subdomain (10 min)

**Runtime: your DNS provider (Vercel / Cloudflare / registrar).**

In the Render dashboard, `a2e-registry` shows its public URL — looks
like `https://a2e-registry-xyzab.onrender.com`. Optionally, set up a
friendly subdomain.

**Option A — use the default Render URL** (no DNS needed):
- `docker login` command becomes:
  ```
  docker login a2e-registry-xyzab.onrender.com -u <USER_ID> -p <API_KEY>
  ```

**Option B — friendly subdomain** (recommended for prod):
1. In Render → a2e-registry → Settings → Custom Domains, add
   `a2e-registry.tokenos.ai` (or whichever subdomain you want)
2. Render shows a CNAME target like `a2e-registry-xyzab.onrender.com`
3. Add the CNAME record in your DNS provider
4. Render auto-provisions an SSL cert via Let's Encrypt (~5 min)

---

## Step 7 — End-to-end docker push test (10 min)

**Runtime: local PowerShell (NOT Render Web Shell — Docker daemon
needs to run locally).**

```powershell
# 7a. Set up vars. Replace placeholders with real values:
#   - REGISTRY = your Render URL OR friendly subdomain
#   - USER_ID = your buyer User.id (CUID) - get one from any test
#               registration. To get a real buyer ID for your own
#               account, hit the portal /buyer/api-keys page; it
#               surfaces your User.id implicitly via the keys you
#               see. Or query the DB.
#   - API_KEY = a2e-buyer-... key with registry:read + registry:write
$REGISTRY = "a2e-registry.tokenos.ai"
$USER_ID = "<paste-your-buyer-user-id>"
$API_KEY = "<paste-an-a2e-buyer-key-with-registry-scopes>"

# 7b. Login. First-time login may take a few seconds while Docker
# fetches the realm + token round-trips.
docker login $REGISTRY -u $USER_ID -p $API_KEY

# Expected output: "Login Succeeded"

# 7c. Pull a tiny image, retag it for our registry, push.
docker pull alpine:3.18
docker tag alpine:3.18 "$REGISTRY/$USER_ID/test-image:v1"
docker push "$REGISTRY/$USER_ID/test-image:v1"

# Expected output:
#   Pushed digest: sha256:...
#   v1: digest: sha256:... size: 528

# 7d. Pull the image back to confirm round-trip works.
docker rmi "$REGISTRY/$USER_ID/test-image:v1"
docker pull "$REGISTRY/$USER_ID/test-image:v1"
```

**Pass criteria:**
- 7b: "Login Succeeded"
- 7c: push completes with `size: <N>` line, no errors
- 7d: pull completes with `Status: Downloaded newer image`

**Common failures:**
- `unauthorized: authentication required` on push: token endpoint
  isn't issuing RS256 tokens (REGISTRY_JWT_PRIVATE_KEY missing or
  wrong format) — check Render logs on a2e-api for the HS256 warning
- `denied: requested access to the resource is denied` on push:
  the repository path doesn't start with your USER_ID (you wrote
  `someoneelse/test-image` instead of `<your-id>/test-image`)
- `500 Internal Server Error` from the registry: usually S3 config
  problem — check a2e-registry logs

---

## Step 8 — Confirm webhook arrives at the API (5 min)

The registry POSTs to `/v1/registry/webhook` on every push event. The
endpoint doesn't exist yet (that's M3.9a), so the registry will log
delivery failures with 404. **That's expected for now.**

To verify the registry is at least TRYING to call the API:
1. Render → a2e-registry → Logs
2. Look for `Sending notification to https://a2e-api.onrender.com/v1/registry/webhook`
3. The HTTP response will be 404 — that's fine until M3.9a ships

If you don't see the log line, double-check `REGISTRY_NOTIFICATIONS_*`
env vars on the registry service (Step 5).

---

## Step 9 — Cleanup local keys (1 min)

**Runtime: local PowerShell.**

```powershell
cd "$env:TEMP\a2e-registry-keys"
Remove-Item registry-*.pem -Force
# The Render dashboard is the only persistent home for the keys now.
```

---

## Verification summary

After all 9 steps:
- ✅ a2e-registry service running on Render (Status: Live)
- ✅ Docker Hub-style push/pull working against `<REGISTRY>/<USER_ID>/<repo>:<tag>`
- ✅ Cross-namespace pushes denied (try pushing as user A to user B's namespace — fails with `denied`)
- ✅ Render a2e-api logs no longer print the HS256 fallback warning (means RS256 path is active)

**M3.8c is then complete.** Next session: M3.9a (webhook receiver +
Trivy worker scaffold), which will start populating DockerImage +
ImageScan rows.

---

## Rollback (if anything goes catastrophically wrong)

The registry service is fully independent from the API. To disable:
1. Render → a2e-registry → Settings → Suspend Service
2. Optionally: revert the `render.yaml` Blueprint change and re-sync

The token issuer at /v1/registry/token keeps working but issues
tokens with no consumer, identical to the M3.8b state. No buyer-
visible regression.
