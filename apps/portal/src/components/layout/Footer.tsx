export function Footer() {
  return (
    <footer className="border-t border-border py-6 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between text-sm text-text-muted">
        <span>&copy; {new Date().getFullYear()} TokenOS. All rights reserved.</span>
        <div className="flex items-center gap-4">
          <a href="https://compute.tokenos.ai/docs" target="_blank" rel="noopener noreferrer" className="hover:text-text-secondary transition-colors">Docs</a>
          <a href="https://compute.tokenos.ai" target="_blank" rel="noopener noreferrer" className="hover:text-text-secondary transition-colors">Platform</a>
        </div>
      </div>
    </footer>
  )
}
