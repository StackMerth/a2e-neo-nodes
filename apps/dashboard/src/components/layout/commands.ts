/*
 * Cmd-K command registry for the admin app.
 *
 * Two sets of commands live here:
 *   1. NAV_COMMANDS - every routable admin page. Pressing enter on
 *      one calls router.push(href).
 *   2. ACTION_COMMANDS - first-class "do something" entries. Each
 *      action returns a promise so the palette can await it, show
 *      a toast on success/failure, then close.
 *
 * Actions deliberately do not take parameters from the palette UI
 * yet. The next layer (M4.6.b) can add inline prompts (e.g. for
 * pause-node-by-id), but the first cut focuses on zero-arg "next
 * pending X" actions that admins run all day.
 */

import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Server, Briefcase, GitBranch, Users, Wallet,
  Rocket, Monitor, Star, TrendingUp, Globe, BarChart3, CreditCard,
  DollarSign, Receipt, FileText, ClipboardCheck, Settings,
  CheckCircle2, Zap, AlertCircle, RefreshCw, CalendarClock,
} from 'lucide-react'
import { api } from '@/lib/api'

export interface CommandContext {
  push: (href: string) => void
  toast: (kind: 'success' | 'error' | 'info', message: string) => void
}

export interface NavCommand {
  id: string
  kind: 'nav'
  label: string
  hint: string
  href: string
  icon: LucideIcon
}

export interface ActionCommand {
  id: string
  kind: 'action'
  label: string
  hint: string
  icon: LucideIcon
  exec: (ctx: CommandContext) => Promise<void> | void
}

export type Command = NavCommand | ActionCommand

// ---------------------------------------------------------------------
// Navigation commands - every admin page reachable from the palette.
// ---------------------------------------------------------------------

export const NAV_COMMANDS: NavCommand[] = [
  { id: 'nav-dashboard',     kind: 'nav', label: 'Dashboard',        hint: 'Network overview',              href: '/',             icon: LayoutDashboard },
  { id: 'nav-nodes',         kind: 'nav', label: 'Nodes',            hint: 'All registered machines',       href: '/nodes',        icon: Server },
  { id: 'nav-jobs',          kind: 'nav', label: 'Jobs',             hint: 'Job log',                       href: '/jobs',         icon: Briefcase },
  { id: 'nav-routing',       kind: 'nav', label: 'Routing',          hint: 'Routing engine + decisions',    href: '/routing',      icon: GitBranch },
  { id: 'nav-nrs',           kind: 'nav', label: 'Node Runners',     hint: 'Operator profiles',             href: '/node-runners', icon: Users },
  { id: 'nav-investments',   kind: 'nav', label: 'Investments',      hint: 'Operator capital',              href: '/investments',  icon: Wallet },
  { id: 'nav-deployments',   kind: 'nav', label: 'Deployments',      hint: 'Pending + provisioned',         href: '/deployments',  icon: Rocket },
  { id: 'nav-compute',       kind: 'nav', label: 'Compute',          hint: 'Buyer compute requests',        href: '/compute',      icon: Monitor },
  { id: 'nav-ratings',       kind: 'nav', label: 'Ratings',          hint: 'Moderation queue',              href: '/ratings',      icon: Star },
  { id: 'nav-rates',         kind: 'nav', label: 'Rates',            hint: 'Per-tier rate config',          href: '/rates',        icon: TrendingUp },
  { id: 'nav-external',      kind: 'nav', label: 'External Markets', hint: 'Vast.ai / overflow config',     href: '/external',     icon: Globe },
  { id: 'nav-financial',     kind: 'nav', label: 'Financial',        hint: 'Top-line P&L',                  href: '/financial',    icon: BarChart3 },
  { id: 'nav-payments',      kind: 'nav', label: 'Payments',         hint: 'Solana settlements + payments', href: '/payments',     icon: CreditCard },
  { id: 'nav-earnings',      kind: 'nav', label: 'Earnings',         hint: 'Operator earnings ledger',      href: '/earnings',     icon: DollarSign },
  { id: 'nav-costs',         kind: 'nav', label: 'Costs',            hint: 'Infrastructure costs',          href: '/costs',        icon: Receipt },
  { id: 'nav-reports',       kind: 'nav', label: 'Reports',          hint: 'Generated reports',             href: '/reports',      icon: FileText },
  { id: 'nav-withdrawals',   kind: 'nav', label: 'Withdrawals',      hint: 'Operator withdrawal queue',     href: '/withdrawals',  icon: Wallet },
  { id: 'nav-audit',         kind: 'nav', label: 'Audit',            hint: 'Audit log',                     href: '/audit',        icon: ClipboardCheck },
  { id: 'nav-settings',      kind: 'nav', label: 'Settings',         hint: 'Admin + smtp + auth',           href: '/settings',     icon: Settings },
]

// ---------------------------------------------------------------------
// Action commands - "do something" without leaving the keyboard.
// Each looks up the relevant queue, picks the oldest item, executes
// the side-effect via the admin API, toasts the result, and navigates
// the admin to the affected record for visual confirmation.
// ---------------------------------------------------------------------

interface ListResponse<T> { rows?: T[]; requests?: T[]; ratings?: T[]; withdrawals?: T[] }
const firstOf = <T>(res: unknown, keys: string[]): T | null => {
  if (!res || typeof res !== 'object') return null
  const obj = res as ListResponse<T>
  for (const k of keys) {
    const arr = (obj as Record<string, unknown>)[k]
    if (Array.isArray(arr) && arr.length > 0) return arr[0] as T
  }
  return null
}

export const ACTION_COMMANDS: ActionCommand[] = [
  {
    id: 'act-approve-next-compute',
    kind: 'action',
    label: 'Approve next pending compute request',
    hint: 'Approves the oldest PENDING request, then opens it',
    icon: CheckCircle2,
    async exec({ push, toast }) {
      try {
        const list = await api.compute.list('PENDING') as ListResponse<{ id: string; gpuTier?: string; gpuCount?: number }>
        const first = firstOf<{ id: string; gpuTier?: string; gpuCount?: number }>(list, ['requests', 'rows'])
        if (!first) {
          toast('info', 'No pending compute requests')
          return
        }
        await api.compute.approve(first.id)
        toast('success', `Approved ${first.gpuCount ?? '?'}x ${first.gpuTier ?? 'request'}`)
        push(`/compute?focus=${first.id}`)
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Approve failed')
      }
    },
  },
  {
    id: 'act-auto-allocate-next',
    kind: 'action',
    label: 'Auto-allocate next pending request',
    hint: 'Runs the allocator against the oldest PENDING request',
    icon: Zap,
    async exec({ push, toast }) {
      try {
        const list = await api.compute.list('PENDING') as ListResponse<{ id: string }>
        const first = firstOf<{ id: string }>(list, ['requests', 'rows'])
        if (!first) {
          toast('info', 'No pending requests to allocate')
          return
        }
        const result = await api.compute.autoAllocate(first.id)
        toast('success', `Allocated ${result.nodesAllocated} node${result.nodesAllocated === 1 ? '' : 's'}`)
        push(`/compute?focus=${first.id}`)
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Auto-allocate failed')
      }
    },
  },
  {
    id: 'act-approve-next-rating',
    kind: 'action',
    label: 'Approve next pending rating',
    hint: 'Moves the oldest PENDING rating to APPROVED',
    icon: Star,
    async exec({ push, toast }) {
      try {
        const list = await api.ratings.list('PENDING') as ListResponse<{ id: string; score: number }>
        const first = firstOf<{ id: string; score: number }>(list, ['ratings', 'rows'])
        if (!first) {
          toast('info', 'No pending ratings')
          return
        }
        await api.ratings.approve(first.id)
        toast('success', `Approved ${first.score}-star rating`)
        push('/ratings')
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Approve rating failed')
      }
    },
  },
  {
    id: 'act-approve-next-withdrawal',
    kind: 'action',
    label: 'Approve next pending withdrawal',
    hint: 'Moves the oldest PENDING withdrawal to APPROVED',
    icon: Wallet,
    async exec({ push, toast }) {
      try {
        const list = await api.withdrawals.list('PENDING') as ListResponse<{ id: string; amount?: number }>
        const first = firstOf<{ id: string; amount?: number }>(list, ['withdrawals', 'rows'])
        if (!first) {
          toast('info', 'No pending withdrawals')
          return
        }
        await api.withdrawals.approve(first.id)
        toast('success', `Approved withdrawal${first.amount ? ` of $${first.amount.toFixed(2)}` : ''}`)
        push('/withdrawals')
      } catch (e) {
        toast('error', e instanceof Error ? e.message : 'Approve withdrawal failed')
      }
    },
  },
  {
    id: 'act-audit-today',
    kind: 'action',
    label: "Open today's audit log",
    hint: 'Audit page filtered to the current calendar day',
    icon: CalendarClock,
    exec({ push }) {
      const today = new Date().toISOString().slice(0, 10)
      push(`/audit?from=${today}`)
    },
  },
  {
    id: 'act-refresh',
    kind: 'action',
    label: 'Refresh current page',
    hint: 'Re-fetches the data on the page you are looking at',
    icon: RefreshCw,
    exec() {
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    },
  },
  {
    id: 'act-deploy-failed',
    kind: 'action',
    label: 'Open failed deployments',
    hint: 'Jumps to /deployments?status=FAILED',
    icon: AlertCircle,
    exec({ push }) {
      push('/deployments?status=FAILED')
    },
  },
]

export const ALL_COMMANDS: Command[] = [...NAV_COMMANDS, ...ACTION_COMMANDS]
