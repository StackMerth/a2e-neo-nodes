/*
 * Cmd-K action commands for the portal app.
 *
 * Smaller set than admin since operators and buyers don't have an
 * approval queue. Actions cover the high-frequency operator chores
 * (pause/resume the fleet) plus quick buyer jumps (request compute,
 * withdraw).
 *
 * Nav-only search and record search (nodes/deployments/rentals)
 * already live in GlobalSearch.tsx; this file adds a third bucket of
 * "actions" the palette renders alongside.
 */

import type { LucideIcon } from 'lucide-react'
import {
  PauseCircle, PlayCircle, Plus, ArrowDownToLine, RefreshCw,
} from 'lucide-react'
import { nodeRunner } from '@/lib/api'

export interface PortalCommandContext {
  push: (href: string) => void
  toast: (kind: 'success' | 'error' | 'info', message: string) => void
}

export interface PortalActionCommand {
  id: string
  label: string
  hint: string
  icon: LucideIcon
  exec: (ctx: PortalCommandContext) => Promise<void> | void
}

export const PORTAL_ACTIONS: PortalActionCommand[] = [
  {
    id: 'act-pause-all',
    label: 'Pause all my nodes',
    hint: 'Sets every ONLINE node owned by you to PAUSED',
    icon: PauseCircle,
    async exec({ toast }) {
      try {
        const res = await nodeRunner.pauseAll()
        toast('success', res.message ?? `Paused ${res.count} node${res.count === 1 ? '' : 's'}`)
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Pause failed')
      }
    },
  },
  {
    id: 'act-resume-all',
    label: 'Resume all my nodes',
    hint: 'Sets every PAUSED node owned by you back to ONLINE',
    icon: PlayCircle,
    async exec({ toast }) {
      try {
        const res = await nodeRunner.resumeAll()
        toast('success', res.message ?? `Resumed ${res.count} node${res.count === 1 ? '' : 's'}`)
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Resume failed')
      }
    },
  },
  {
    id: 'act-request-compute',
    label: 'Request compute',
    hint: 'Open the rental wizard',
    icon: Plus,
    exec({ push }) {
      push('/buyer/request')
    },
  },
  {
    id: 'act-withdraw',
    label: 'Withdraw earnings',
    hint: 'Open Platform Balance on the Payouts page',
    icon: ArrowDownToLine,
    exec({ push }) {
      push('/payouts')
    },
  },
  {
    id: 'act-refresh',
    label: 'Refresh current page',
    hint: 'Re-fetches the data on the page you are looking at',
    icon: RefreshCw,
    exec() {
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    },
  },
]
