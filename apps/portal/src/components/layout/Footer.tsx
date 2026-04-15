export function Footer() {
  return (
    <footer className="portal-footer">
      <span>&copy; {new Date().getFullYear()} TokenOS. All rights reserved.</span>
      {' \u2022 '}
      <a href="https://compute.tokenos.ai/docs" target="_blank" rel="noopener noreferrer">Docs</a>
      {' \u2022 '}
      <a href="https://compute.tokenos.ai" target="_blank" rel="noopener noreferrer">Platform</a>
    </footer>
  )
}
