'use client'

import { createContext, useContext, useState, ReactNode } from 'react'

interface TabsContextType {
  activeTab: string
  setActiveTab: (tab: string) => void
}

const TabsContext = createContext<TabsContextType | null>(null)

interface TabsProps {
  defaultTab: string
  children: ReactNode
  className?: string
  onChange?: (tab: string) => void
}

export function Tabs({ defaultTab, children, className = '', onChange }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab)

  const handleTabChange = (tab: string) => {
    setActiveTab(tab)
    onChange?.(tab)
  }

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab: handleTabChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

interface TabListProps {
  children: ReactNode
  className?: string
}

export function TabList({ children, className = '' }: TabListProps) {
  return (
    <div className={`flex gap-1 p-1 bg-surface-hover rounded-lg ${className}`}>
      {children}
    </div>
  )
}

interface TabProps {
  value: string
  children: ReactNode
  icon?: ReactNode
  className?: string
}

export function Tab({ value, children, icon, className = '' }: TabProps) {
  const context = useContext(TabsContext)
  if (!context) throw new Error('Tab must be used within Tabs')

  const { activeTab, setActiveTab } = context
  const isActive = activeTab === value

  return (
    <button
      type="button"
      onClick={() => setActiveTab(value)}
      className={`
        flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all
        ${isActive
          ? 'bg-surface text-accent shadow-sm'
          : 'text-text-secondary hover:text-text-primary'
        }
        ${className}
      `}
    >
      {icon}
      {children}
    </button>
  )
}

interface TabPanelProps {
  value: string
  children: ReactNode
  className?: string
}

export function TabPanel({ value, children, className = '' }: TabPanelProps) {
  const context = useContext(TabsContext)
  if (!context) throw new Error('TabPanel must be used within Tabs')

  const { activeTab } = context
  if (activeTab !== value) return null

  return <div className={className}>{children}</div>
}

// Vertical Tabs variant for settings pages
interface VerticalTabsProps {
  tabs: Array<{ value: string; label: string; icon?: ReactNode }>
  activeTab: string
  onTabChange: (tab: string) => void
  className?: string
}

export function VerticalTabs({ tabs, activeTab, onTabChange, className = '' }: VerticalTabsProps) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onTabChange(tab.value)}
          className={`
            flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg transition-all text-left
            ${activeTab === tab.value
              ? 'bg-accent/10 text-accent border-l-2 border-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
            }
          `}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  )
}
