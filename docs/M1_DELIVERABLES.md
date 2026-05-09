# M1 Deliverables Report

**Milestone:** Production Foundation
**Status:** 8 of 11 items shipped (about 73 percent complete)
**Audience:** Anyone, technical or not

This document explains what was built in M1, what it means for the
business, and how to confirm each item. It's written for someone
who doesn't read code. If you do read code, every item has a commit
hash you can look up.

---

## What is M1, in plain English?

M1 is the work that turns the platform from "it runs" to "it can
go public without falling over." None of it changes what buyers or
node runners see on their screen. All of it is the safety net
underneath.

Think of it like getting a building inspected before opening the
doors. The walls and floors are already there from Phase 1. M1 is
the smoke detectors, the backup generator, the security cameras,
and the locks on the doors.

---

## Items shipped

### 1. Self-protection against secrets leaking

We added a `.gitignore` file to the repository. Without it, anyone
adding new code could accidentally commit a `.env` file containing
the database password or wallet private keys.

Also cleaned up some unnecessary files (build cache from Phase 1)
that shouldn't have been in the codebase.

**Why it matters:** Stops the most common cause of credential leaks
in software projects. Costs nothing to maintain.

**How to verify:** Visit
[github.com/StackMerth/a2e-neo-nodes/blob/main/.gitignore](https://github.com/StackMerth/a2e-neo-nodes/blob/main/.gitignore)
to see the file is present.

**Commit:** `33e2c6d`

---

### 2. Automatic database cleanup

The platform writes a heartbeat to the database every 30 seconds for
every connected node. With 100 active nodes, that's 8.6 million rows
per month. Without cleanup, the database fills up, queries slow
down, and eventually the platform stops responding.

We added two automated cleanup jobs that run every 24 hours:

- **Heartbeat cleanup:** deletes records older than 30 days
- **Market rate history cleanup:** deletes records older than 90 days

Both are configurable. You can keep more or less history by
changing two environment variables.

**Why it matters:** The database stays healthy and fast indefinitely
no matter how many nodes connect.

**How to verify:** In the Render dashboard, open **a2e-api → Logs**
and search for "retention". You'll see two startup messages
confirming both jobs are scheduled:

```
[retention] heartbeat scheduled: every 24h, keep last 30 days
[retention] rate-history scheduled: every 24h, keep last 90 days
```

**Commit:** `33e2c6d`

---

### 3. Real-time error tracking (Sentry)

Before M1, when something broke in the platform, the only way to
find out was a user complaining. Now we have Sentry, an industry-
standard error tracking service.

The way it works: any time the platform throws an error, the full
details (what went wrong, when, who was using it, the exact code
path) are sent to a private Sentry dashboard within 5 seconds. We
can see problems before users finish typing complaints.

Three Sentry projects are configured:

- **a2e-api** — backend errors
- **a2e-dashboard** — admin dashboard errors
- **a2e-portal** — buyer and node runner portal errors

**Why it matters:** Issues get diagnosed in minutes instead of
days. Customer complaints come with a stack trace already attached.

**How to verify:**

1. Visit [https://a2e-api.onrender.com/v1/admin/sentry-test](https://a2e-api.onrender.com/v1/admin/sentry-test)
2. You'll see a deliberate error response (this is the test signal)
3. Open your Sentry dashboard → a2e-api project → Issues
4. The error appears within 10 seconds

**Commits:** `6adc0ac`, `d430262`

---

### 4. Cancel button that actually cancels

Before M1, if a node deployment got stuck (because the SSH
connection to the GPU server was hanging), clicking the Cancel
button only updated a status field. The underlying job kept
running, hung on the network call, and the deployment couldn't
be retried.

Now Cancel actually stops the job. Three layers of cancellation:

1. The deployment record is marked Cancelled
2. The provisioning job is marked Cancelled
3. The background worker is removed from the queue
4. The provisioning code itself checks every step whether it's
   been Cancelled and aborts cleanly

A new "force cancel stuck" admin endpoint also exists for emergency
cleanup if a job is wedged at a low level.

**Why it matters:** Operators can recover from stuck deployments
in seconds instead of needing to manually edit the database.

**How to verify:**

1. Admin dashboard → Deployments
2. Find a deployment in `DEPLOYMENT_REQUESTED` status
3. Click Deploy Now
4. Use bogus SSH details (e.g., host `1.2.3.4`) and **uncheck**
   Test Mode
5. The deployment will hang on `CONNECTING`
6. After about 30 seconds, click Cancel
7. Within 10 seconds the status flips to Cancelled and the
   investment goes back to deployable

**Commit:** `0bfa41d`

---

### 5. Admin login uses proper standard tokens

The original admin login used a custom-built token format with a
"for demo purposes" comment in the source code. M1 replaced this
with a real JSON Web Token (the same standard the buyer/node-runner
portal uses). This makes the codebase smaller, removes a special
case in the authentication code, and prepares the platform for
adding features like single sign-on later.

**Why it matters:** Admin authentication is now production-grade
instead of demo-grade. Cleaner code, fewer edge cases, easier to
extend.

**How to verify:**

1. Log out of the admin dashboard (or clear cookies)
2. Log in again with admin credentials
3. Press F12 → Application → Local Storage
4. The `a2e_admin_token` value will be a JWT (a long string in
   three parts separated by dots, starting with `eyJ...`)

**Commit:** `1323902`

---

### 6. Branded loading indicator (already shipped before M1)

Note: this was shipped during the QA pass right before M1 started.
Listed here because it's user-facing and was part of the same
session.

When any dashboard or portal page is loading data, users now see a
pulsing A2E logo instead of generic skeleton placeholders. Reinforces
the brand.

**Why it matters:** Cohesive visual language. Even loading states
look like part of the platform.

**How to verify:** Visit any dashboard page after a fresh login.
You'll see the A2E logo briefly pulse before content loads.

**Commit:** `f7e15e7`

---

### 7. Design system foundation

M1 includes design system "kickoff" — the foundation that the
larger UI redesign in M4 will build on. This isn't visible yet
but it's a single source of truth for colors, spacing, typography,
shadows, and motion.

All values that the dashboard and portal already use are now
formalized as a shared package called `@a2e/ui`. When M4 ships the
premium UI redesign, every component will pull from this package,
so changing a brand color happens in one file instead of dozens.

**Why it matters:** Future UI work goes faster and stays
consistent. No more "this button is green here but a different
green over there."

**How to verify:** Visit
[github.com/StackMerth/a2e-neo-nodes/tree/main/packages/ui](https://github.com/StackMerth/a2e-neo-nodes/tree/main/packages/ui).
The README explains the system; tokens.ts and tokens.css are the
actual values.

**Commit:** `35f080d`

---

### 8. Database migration foundation

The Phase 1 database schema was set up in a way that made future
schema changes risky. M1 created a clean baseline that captures
the full current schema in one file (671 lines of SQL). After a
one-time switchover (a 10-minute operator task documented at
`docs/MIGRATION_SWITCHOVER.md`), every future schema change will
be applied incrementally and tracked in a migration history table.

This means: when M2 adds new tables for templates, billing minutes,
and ephemeral SSH credentials, those changes apply safely and
reversibly without manual database surgery.

**Why it matters:** Schema changes during M2/M3/M4 will be safe
and reversible. Without this baseline, every schema change would
require manual database work.

**How to verify:** Visit
[the new baseline migration on GitHub](https://github.com/StackMerth/a2e-neo-nodes/blob/main/packages/database/prisma/migrations/0_init/migration.sql)
to see the 671-line schema, and
[the switchover doc](https://github.com/StackMerth/a2e-neo-nodes/blob/main/docs/MIGRATION_SWITCHOVER.md)
for the operator instructions.

**Commit:** `8b5126d`

---

## Items NOT yet in M1

### A. Diagnose Test Mode bug

The Test Mode checkbox in the deployment form should let you
exercise the deployment flow without a real GPU server. We hit a
bug during QA where it didn't work end-to-end. With Sentry now
collecting errors (item 3), the next time someone tries it, we'll
have the actual stack trace and can diagnose. This is "wait for
data" rather than "build the fix."

### B. Move payer wallet private key out of plain database storage

The Solana wallet private key (used to send real settlement
payouts) currently lives as a plaintext column in the database.
It should live in an encrypted secret store. This is the next
build task on the list.

### C. Status page

A public status.tokenos.ai page that shows whether each component
of the platform is up. Two implementation options (a paid service
called Better Stack, or a self-hosted Astro site). Waiting on a
choice from the operator before building.

### D. Backup script

Nightly database backups to an S3-compatible storage bucket. The
operator decided to defer this until closer to launch (Render's
own daily snapshots are a sufficient safety net for the QA phase).

---

## How to demo this to your team

For a non-technical audience, the most impressive things to show
are items 3 (Sentry), 4 (Cancel button), and 6 (A2E loader).

A 5-minute walkthrough script:

1. **Open the admin dashboard.** Show the loading animation (item 6).
2. **Trigger the Sentry test** by visiting `/v1/admin/sentry-test` in
   a new tab. Switch to the Sentry dashboard, refresh, point at the
   new error. Say: "this is what happens to every error in
   production now — we see them in seconds."
3. **Trigger a stuck deployment** following Test D above. While it
   hangs, switch back to the audience and explain what's
   happening. Then click Cancel and show the recovery.
4. **Open `docs/M1_DELIVERABLES.md` (this file)** on GitHub and
   walk through the table of contents. Each item has a "why it
   matters" line they can read directly.

Total time: 5 minutes. Audience walks away knowing the platform
is operationally healthy without needing to look at code.

---

## What comes next

The remaining 3 M1 items will be wrapped up in the following
weeks. After that, M2 begins. M2 is the visible value milestone:

- **Auto-allocator** — buyers get GPU access in 60 seconds without
  any admin clicking. This is the biggest single user-experience
  improvement.
- **Per-minute billing** — refactor pricing engine.
- **Pre-baked ML templates** — buyers get PyTorch + Jupyter ready
  in seconds.

When M2 ships, the visible deliverable list gets a lot more
exciting and we can run an actual buyer through the end-to-end
flow without any hand-holding.

---

*This document was generated as a deliverable summary. The
underlying code is in the repository at
[StackMerth/a2e-neo-nodes](https://github.com/StackMerth/a2e-neo-nodes).
Questions, send them to whoever asked you to read this.*
