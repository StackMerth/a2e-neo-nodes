/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // TokenOS brand colors (matching compute.tokenos.ai)
        background: '#0a0a0a',
        surface: '#111111',
        'surface-hover': '#1a1a1a',
        border: '#222222',
        'text-primary': '#ffffff',
        'text-secondary': '#a1a1a1',
        'text-muted': '#666666',
        // Green accent (TokenOS brand)
        accent: '#22c55e',
        'accent-hover': '#16a34a',
        'accent-muted': '#166534',
        success: '#22c55e',
        warning: '#f59e0b',
        error: '#ef4444',
      },
    },
  },
  plugins: [],
}
