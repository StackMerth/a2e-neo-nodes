/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#0a0a0a',
        surface: { DEFAULT: '#111111', hover: '#1a1a1a', elevated: '#161616' },
        border: { DEFAULT: '#222222', subtle: '#1a1a1a' },
        'text-primary': '#ffffff',
        'text-secondary': '#a1a1a1',
        'text-muted': '#666666',
        accent: { DEFAULT: '#22c55e', hover: '#16a34a' },
      },
    },
  },
  plugins: [],
}
