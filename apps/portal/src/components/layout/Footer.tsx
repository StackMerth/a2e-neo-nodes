export function Footer() {
  return (
    <footer className="portal-footer">
      <span>&copy; {new Date().getFullYear()} TokenOS. All rights reserved.</span>
      {' • '}
      <a href="https://market.tokenos.ai" target="_blank" rel="noopener noreferrer">Marketplace</a>
      {' • '}
      <a href="https://market.tokenos.ai/stats" target="_blank" rel="noopener noreferrer">Network stats</a>
    </footer>
  )
}
