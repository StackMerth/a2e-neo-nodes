'use client'

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, FileText, DollarSign, Receipt, TrendingUp, BarChart3, Briefcase, Landmark, Server, Calendar, Check, AlertTriangle, Info } from 'lucide-react'
import { Card, StatCard } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DateRangePicker } from '@/components/ui/DateRangePicker'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
}

type ReportType = 'earnings' | 'settlements' | 'jobs' | 'nodes'

interface DateRange {
  start: Date | null
  end: Date | null
}

interface ReportSummary {
  period: { start: string; end: string }
  revenue: { total: number; gpuHours: number; jobCount: number }
  costs: { total: number }
  profit: { gross: number; margin: number }
  settlements: { completed: number; amount: number }
  activity: { totalJobs: number; activeNodes: number }
}

export default function ReportsPage() {
  const { addToast } = useToast()
  const [reportType, setReportType] = useState<ReportType>('earnings')
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null })
  const [downloading, setDownloading] = useState<string | null>(null)
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)

  useEffect(() => {
    loadSummary()
  }, [dateRange])

  async function loadSummary() {
    setLoadingSummary(true)
    try {
      const days = dateRange.start && dateRange.end
        ? Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24))
        : 30
      const data = await api.reports.summary({ days })
      setSummary(data)
    } catch (err) {
      console.error('Failed to load summary:', err)
    } finally {
      setLoadingSummary(false)
    }
  }

  function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(value)
  }

  const reportTypes: Array<{ value: ReportType; label: string; description: string; icon: React.ReactNode; color: string }> = [
    {
      value: 'earnings',
      label: 'Earnings Report',
      description: 'Revenue breakdown by market, node, and time period',
      icon: <DollarSign className="w-5 h-5" />,
      color: 'from-accent to-emerald-400',
    },
    {
      value: 'settlements',
      label: 'Settlements Report',
      description: 'All settlements with payment status and transaction details',
      icon: <Landmark className="w-5 h-5" />,
      color: 'from-purple-500 to-purple-400',
    },
    {
      value: 'jobs',
      label: 'Jobs Report',
      description: 'Complete job history with routing decisions and earnings',
      icon: <Briefcase className="w-5 h-5" />,
      color: 'from-blue-500 to-blue-400',
    },
    {
      value: 'nodes',
      label: 'Nodes Report',
      description: 'Node registry with status, GPU tiers, and performance metrics',
      icon: <Server className="w-5 h-5" />,
      color: 'from-orange-500 to-orange-400',
    },
  ]

  async function handleDownloadCSV(type: ReportType) {
    setDownloading(`${type}-csv`)
    try {
      await api.reports.downloadCSV(type)
      addToast({ type: 'success', title: 'Download Started', message: `${type} CSV download started` })
    } catch (err) {
      addToast({ type: 'error', title: 'Download Failed', message: err instanceof Error ? err.message : 'Download failed' })
    } finally {
      setDownloading(null)
    }
  }

  async function handleDownloadPDF(type: 'earnings' | 'settlements') {
    setDownloading(`${type}-pdf`)
    try {
      await api.reports.downloadPDF(type, {
        startDate: dateRange.start?.toISOString().split('T')[0],
        endDate: dateRange.end?.toISOString().split('T')[0],
      })
      addToast({ type: 'success', title: 'Download Started', message: `${type} PDF download started` })
    } catch (err) {
      addToast({ type: 'error', title: 'Download Failed', message: err instanceof Error ? err.message : 'Download failed' })
    } finally {
      setDownloading(null)
    }
  }

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item} className="dash-header">
        <div className="dash-header-left">
          <h1><FileText size={28} /> Reports</h1>
        </div>
        <div className="dash-header-right" />
      </motion.div>

      {/* Date Range Filter */}
      <Card variant="glass" hover={false}>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
              <Calendar className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <span className="text-sm font-medium text-text-primary">Report Period</span>
              <p className="text-xs text-text-muted">Select a date range for your reports</p>
            </div>
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              className="w-64"
            />
            {(dateRange.start || dateRange.end) && (
              <button
                onClick={() => setDateRange({ start: null, end: null })}
                className="text-xs text-text-muted hover:text-text-primary px-3 py-2 bg-surface-hover rounded-lg"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard
            label="Total Revenue"
            value={formatCurrency(summary.revenue.total)}
            variant="accent"
            animate
            icon={<DollarSign className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
          <StatCard
            label="Total Costs"
            value={formatCurrency(summary.costs.total)}
            variant="orange"
            animate
            icon={<Receipt className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
          <StatCard
            label="Gross Profit"
            value={formatCurrency(summary.profit.gross)}
            variant="accent"
            animate
            icon={<TrendingUp className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
          <StatCard
            label="Profit Margin"
            value={`${summary.profit.margin.toFixed(1)}%`}
            variant="purple"
            animate
            icon={<BarChart3 className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
          <StatCard
            label="Total Jobs"
            value={summary.activity.totalJobs.toLocaleString()}
            variant="blue"
            animate
            icon={<Briefcase className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
          <StatCard
            label="Settlements Paid"
            value={formatCurrency(summary.settlements.amount)}
            animate
            icon={<Landmark className="w-4 h-4" />}
            className={loadingSummary ? 'animate-pulse' : ''}
          />
        </div>
      )}

      {/* Report Types */}
      <div className="grid md:grid-cols-2 gap-4">
        {reportTypes.map((report) => (
          <div
            key={report.value}
            onClick={() => setReportType(report.value)}
            className={`cursor-pointer p-6 rounded-2xl bg-surface/60 backdrop-blur-xl border transition-all ${
              reportType === report.value
                ? 'ring-2 ring-accent border-accent/30 shadow-[0_0_20px_rgba(34,197,94,0.1)]'
                : 'border-white/5 hover:border-accent/30'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${report.color} flex items-center justify-center shrink-0`}>
                {report.icon}
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-text-primary mb-1">{report.label}</h3>
                <p className="text-sm text-text-muted mb-4">{report.description}</p>

                <div className="flex gap-2">
                  <Button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDownloadCSV(report.value)
                    }}
                    disabled={downloading === `${report.value}-csv`}
                    variant="outline"
                    size="sm"
                    icon={<Download className="w-4 h-4" />}
                  >
                    {downloading === `${report.value}-csv` ? 'Downloading...' : 'CSV'}
                  </Button>
                  {(report.value === 'earnings' || report.value === 'settlements') && (
                    <Button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownloadPDF(report.value as 'earnings' | 'settlements')
                      }}
                      disabled={downloading === `${report.value}-pdf`}
                      variant="primary"
                      size="sm"
                      icon={<FileText className="w-4 h-4" />}
                    >
                      {downloading === `${report.value}-pdf` ? 'Generating...' : 'PDF'}
                    </Button>
                  )}
                </div>
              </div>
              {reportType === report.value && (
                <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center shrink-0">
                  <Check className="w-4 h-4 text-white" />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Quick Export */}
      <Card variant="glass" hover={false}>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-400 flex items-center justify-center">
            <Download className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">Quick Export</h3>
            <p className="text-xs text-text-muted">Download all data in CSV format</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => handleDownloadCSV('earnings')}
            disabled={downloading !== null}
            variant="outline"
            icon={<DollarSign className="w-4 h-4" />}
          >
            All Earnings
          </Button>
          <Button
            onClick={() => handleDownloadCSV('settlements')}
            disabled={downloading !== null}
            variant="outline"
            icon={<Landmark className="w-4 h-4" />}
          >
            All Settlements
          </Button>
          <Button
            onClick={() => handleDownloadCSV('jobs')}
            disabled={downloading !== null}
            variant="outline"
            icon={<Briefcase className="w-4 h-4" />}
          >
            All Jobs
          </Button>
          <Button
            onClick={() => handleDownloadCSV('nodes')}
            disabled={downloading !== null}
            variant="outline"
            icon={<Server className="w-4 h-4" />}
          >
            All Nodes
          </Button>
        </div>
      </Card>

      {/* Generate Invoice */}
      <Card variant="glass" hover={false}>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-400 flex items-center justify-center">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary">Generate Invoice</h3>
            <p className="text-xs text-text-muted">Create a PDF invoice for a specific settlement period</p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-2">Invoice Period</label>
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              className="w-64"
            />
          </div>
          <Button
            onClick={() => handleDownloadPDF('settlements')}
            disabled={downloading === 'settlements-pdf' || !dateRange.start || !dateRange.end}
            variant="primary"
            icon={<FileText className="w-4 h-4" />}
          >
            {downloading === 'settlements-pdf' ? 'Generating...' : 'Generate Invoice'}
          </Button>
        </div>

        {(!dateRange.start || !dateRange.end) && (
          <div className="mt-4 p-3 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
            <p className="text-xs text-warning">Select a date range to generate an invoice</p>
          </div>
        )}
      </Card>

      {/* Report Info */}
      <Card variant="glass" hover={false}>
        <div className="flex items-center gap-3 mb-4">
          <Info className="w-5 h-5 text-accent" />
          <h3 className="font-medium text-text-primary">About Reports</h3>
        </div>
        <div className="grid md:grid-cols-2 gap-6 text-sm text-text-secondary">
          <div>
            <h4 className="font-medium text-text-primary mb-2">CSV Exports</h4>
            <p>CSV files contain raw data that can be imported into spreadsheet applications like Excel or Google Sheets for custom analysis.</p>
          </div>
          <div>
            <h4 className="font-medium text-text-primary mb-2">PDF Reports</h4>
            <p>PDF reports include formatted summaries, charts, and detailed breakdowns suitable for stakeholder presentations or record-keeping.</p>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

// =============================================================================
// ICONS
// =============================================================================

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ReceiptIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
    </svg>
  )
}

function TrendingUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  )
}

function ChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
    </svg>
  )
}

function BriefcaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

function BankIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3" />
    </svg>
  )
}

function ServerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
  )
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  )
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  )
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  )
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
