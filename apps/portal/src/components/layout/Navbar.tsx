'use client'

import { Menu, X } from 'lucide-react'
import { useSidebar } from './SidebarContext'

export function MobileMenuButton() {
  const { sidebarOpen, toggleSidebar } = useSidebar()
  return (
    <button className="mobile-menu-btn" onClick={toggleSidebar}>
      {sidebarOpen ? <X size={24} /> : <Menu size={24} />}
    </button>
  )
}

/** @deprecated - navigation is now in the Sidebar component */
export function Navbar() {
  return null
}
