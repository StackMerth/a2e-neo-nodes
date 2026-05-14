'use client'

import { useState, useEffect } from 'react'
import { Download, FileText, DollarSign, Receipt, TrendingUp, BarChart3, Briefcase, Landmark, Server, Calendar, Check, AlertTriangle, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DateRangePicker } from '@/components/ui/DateRangePicker'
import { useToast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import {
  DashboardShell,
  FormCard,
  FormSection,
} from '@/components/dashboard/FuturisticShell'

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
    <DashboardShell title="Reports" subtitle="Export data and generate invoices">
      <div className="lg:col-span-3 max-w-5xl mx-auto w-full space-y-6">
        <FormCard
          title="Report Period"
          description="Select a date range for your reports"
          icon={Calendar}
          actions={(dateRange.start || dateRange.end) ? (
            <button
              onClick={() => setDateRange({ start: null, end: null })}
              className="text-xs px-3 py-2 bg-surface-hover rounded-lg"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          ) : undefined}
        >
          <FormSection>
            <DateRangePicker value={dateRange} onChange={setDateRange} className="w-full" />

            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mt-4">
                <SummaryStat label="Total Revenue" value={formatCurrency(summary.revenue.total)} accent="green" />
                <SummaryStat label="Total Costs" value={formatCurrency(summary.costs.total)} accent="orange" />
                <SummaryStat label="Gross Profit" value={formatCurrency(summary.profit.gross)} accent="green" />
                <SummaryStat label="Profit Margin" value={`${summary.profit.margin.toFixed(1)}%`} accent="purple" />
                <SummaryStat label="Total Jobs" value={summary.activity.totalJobs.toLocaleString()} accent="blue" />
                <SummaryStat label="Settlements Paid" value={formatCurrency(summary.settlements.amount)} accent="default" />
              </div>
            )}
          </FormSection>
        </FormCard>

        <FormCard title="Report Type" description="Choose a report to download" icon={FileText}>
          <FormSection>
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
                      <h3 className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{report.label}</h3>
                      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{report.description}</p>

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
          </FormSection>
        </FormCard>

        <FormCard title="Quick Export" description="Download all data in CSV format" icon={Download}>
          <FormSection>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => handleDownloadCSV('earnings')} disabled={downloading !== null} variant="outline" icon={<DollarSign className="w-4 h-4" />}>
                All Earnings
              </Button>
              <Button onClick={() => handleDownloadCSV('settlements')} disabled={downloading !== null} variant="outline" icon={<Landmark className="w-4 h-4" />}>
                All Settlements
              </Button>
              <Button onClick={() => handleDownloadCSV('jobs')} disabled={downloading !== null} variant="outline" icon={<Briefcase className="w-4 h-4" />}>
                All Jobs
              </Button>
              <Button onClick={() => handleDownloadCSV('nodes')} disabled={downloading !== null} variant="outline" icon={<Server className="w-4 h-4" />}>
                All Nodes
              </Button>
            </div>
          </FormSection>
        </FormCard>

        <FormCard
          title="Generate Invoice"
          description="Create a PDF invoice for a specific settlement period"
          icon={FileText}
          footer={
            <Button
              onClick={() => handleDownloadPDF('settlements')}
              disabled={downloading === 'settlements-pdf' || !dateRange.start || !dateRange.end}
              variant="primary"
              icon={<FileText className="w-4 h-4" />}
            >
              {downloading === 'settlements-pdf' ? 'Generating...' : 'Generate Invoice'}
            </Button>
          }
        >
          <FormSection>
            <div>
              <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Invoice Period</label>
              <DateRangePicker value={dateRange} onChange={setDateRange} className="w-full" />
            </div>

            {(!dateRange.start || !dateRange.end) && (
              <div className="p-3 bg-warning/5 border border-warning/20 rounded-xl flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                <p className="text-xs text-warning">Select a date range to generate an invoice</p>
              </div>
            )}
          </FormSection>
        </FormCard>

        <FormCard title="About Reports" icon={Info}>
          <FormSection>
            <div className="grid md:grid-cols-2 gap-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <div>
                <h4 className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>CSV Exports</h4>
                <p>CSV files contain raw data that can be imported into spreadsheet applications like Excel or Google Sheets for custom analysis.</p>
              </div>
              <div>
                <h4 className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>PDF Reports</h4>
                <p>PDF reports include formatted summaries, charts, and detailed breakdowns suitable for stakeholder presentations or record-keeping.</p>
              </div>
            </div>
          </FormSection>
        </FormCard>
      </div>
    </DashboardShell>
  )
}

function SummaryStat({ label, value, accent }: { label: string; value: string; accent: 'green' | 'orange' | 'purple' | 'blue' | 'default' }) {
  const accentColors: Record<typeof accent, string> = {
    green: 'text-accent',
    orange: 'text-warning',
    purple: 'text-purple-400',
    blue: 'text-blue-400',
    default: '',
  }
  return (
    <div className="rounded-md border border-border p-3" style={{ background: 'var(--bg-elevated)' }}>
      <p className="font-mono text-[10px] tracking-[0.14em] uppercase" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p className={`font-display text-xl mt-1 ${accentColors[accent] || ''}`} style={!accentColors[accent] ? { color: 'var(--text-primary)' } : undefined}>
        {value}
      </p>
    </div>
  )
}
