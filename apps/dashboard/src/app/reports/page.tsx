'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { DateRangePicker } from '@/components/ui/DateRangePicker'
import { api } from '@/lib/api'

type ReportType = 'earnings' | 'settlements' | 'jobs' | 'nodes'

interface DateRange {
  start: Date | null
  end: Date | null
}

export default function ReportsPage() {
  const [reportType, setReportType] = useState<ReportType>('earnings')
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null })
  const [downloading, setDownloading] = useState<string | null>(null)

  const reportTypes: Array<{ value: ReportType; label: string; description: string; icon: React.ReactNode }> = [
    {
      value: 'earnings',
      label: 'Earnings Report',
      description: 'Revenue breakdown by market, node, and time period',
      icon: <DollarIcon className="w-5 h-5" />,
    },
    {
      value: 'settlements',
      label: 'Settlements Report',
      description: 'All settlements with payment status and transaction details',
      icon: <BankIcon className="w-5 h-5" />,
    },
    {
      value: 'jobs',
      label: 'Jobs Report',
      description: 'Complete job history with routing decisions and earnings',
      icon: <BriefcaseIcon className="w-5 h-5" />,
    },
    {
      value: 'nodes',
      label: 'Nodes Report',
      description: 'Node registry with status, GPU tiers, and performance metrics',
      icon: <ServerIcon className="w-5 h-5" />,
    },
  ]

  async function handleDownloadCSV(type: ReportType) {
    setDownloading(`${type}-csv`)
    try {
      await api.reports.downloadCSV(type)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed')
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
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Reports</h1>
          <p className="text-text-muted mt-1">Generate and export financial reports</p>
        </div>
      </div>

      {/* Date Range Filter */}
      <Card className="p-4">
        <div className="flex items-center gap-4">
          <span className="text-sm text-text-secondary">Report Period:</span>
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
            className="w-64"
          />
          {(dateRange.start || dateRange.end) && (
            <button
              onClick={() => setDateRange({ start: null, end: null })}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              Clear
            </button>
          )}
        </div>
      </Card>

      {/* Report Types */}
      <div className="grid md:grid-cols-2 gap-4">
        {reportTypes.map((report) => (
          <div
            key={report.value}
            onClick={() => setReportType(report.value)}
            className={`p-6 rounded-xl border cursor-pointer transition-all ${
              reportType === report.value
                ? 'ring-2 ring-accent bg-accent/5 border-accent/30'
                : 'bg-surface border-border hover:bg-surface-hover'
            }`}
          >
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-lg ${reportType === report.value ? 'bg-accent/20 text-accent' : 'bg-surface-hover text-text-muted'}`}>
                {report.icon}
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-text-primary">{report.label}</h3>
                <p className="text-sm text-text-muted mt-1">{report.description}</p>

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDownloadCSV(report.value)
                    }}
                    disabled={downloading === `${report.value}-csv`}
                    className="px-3 py-1.5 text-xs font-medium bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-lg transition-colors disabled:opacity-50"
                  >
                    {downloading === `${report.value}-csv` ? 'Downloading...' : 'Download CSV'}
                  </button>
                  {(report.value === 'earnings' || report.value === 'settlements') && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownloadPDF(report.value as 'earnings' | 'settlements')
                      }}
                      disabled={downloading === `${report.value}-pdf`}
                      className="px-3 py-1.5 text-xs font-medium bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-50"
                    >
                      {downloading === `${report.value}-pdf` ? 'Generating...' : 'Download PDF'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <Card className="p-6">
        <h3 className="font-semibold text-text-primary mb-4">Quick Export</h3>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => handleDownloadCSV('earnings')}
            disabled={downloading !== null}
            className="px-4 py-2 text-sm bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-lg transition-colors disabled:opacity-50"
          >
            All Earnings (CSV)
          </button>
          <button
            onClick={() => handleDownloadCSV('settlements')}
            disabled={downloading !== null}
            className="px-4 py-2 text-sm bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-lg transition-colors disabled:opacity-50"
          >
            All Settlements (CSV)
          </button>
          <button
            onClick={() => handleDownloadCSV('jobs')}
            disabled={downloading !== null}
            className="px-4 py-2 text-sm bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-lg transition-colors disabled:opacity-50"
          >
            All Jobs (CSV)
          </button>
          <button
            onClick={() => handleDownloadCSV('nodes')}
            disabled={downloading !== null}
            className="px-4 py-2 text-sm bg-surface-hover hover:bg-accent/10 hover:text-accent rounded-lg transition-colors disabled:opacity-50"
          >
            All Nodes (CSV)
          </button>
        </div>
      </Card>
    </div>
  )
}

function DollarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
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

function BriefcaseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
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
