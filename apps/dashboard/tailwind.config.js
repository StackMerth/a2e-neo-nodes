/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Background
        background: '#0a0a0a',
        surface: {
          DEFAULT: '#111111',
          hover: '#1a1a1a',
          elevated: '#161616',
        },

        // Borders
        border: {
          DEFAULT: '#222222',
          subtle: '#1a1a1a',
          accent: 'rgba(34, 197, 94, 0.3)',
        },

        // Text
        'text-primary': '#ffffff',
        'text-secondary': '#a1a1a1',
        'text-muted': '#666666',

        // Accent Colors
        accent: {
          DEFAULT: '#22c55e',
          hover: '#16a34a',
          muted: '#166534',
          glow: 'rgba(34, 197, 94, 0.15)',
        },

        // Status Colors
        success: '#22c55e',
        warning: '#f59e0b',
        error: '#ef4444',
        info: '#3b82f6',

        // Additional accent colors
        'accent-blue': {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
          glow: 'rgba(59, 130, 246, 0.15)',
        },
        'accent-purple': {
          DEFAULT: '#8b5cf6',
          hover: '#7c3aed',
          glow: 'rgba(139, 92, 246, 0.15)',
        },
        'accent-orange': {
          DEFAULT: '#f59e0b',
          hover: '#d97706',
          glow: 'rgba(245, 158, 11, 0.15)',
        },
      },

      // Background Images & Gradients
      backgroundImage: {
        'gradient-radial': 'radial-gradient(ellipse at top, var(--tw-gradient-stops))',
        'gradient-accent': 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
        'gradient-blue': 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
        'gradient-purple': 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
        'gradient-orange': 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
        'gradient-mixed': 'linear-gradient(135deg, #22c55e 0%, #3b82f6 50%, #8b5cf6 100%)',
        'gradient-surface': 'linear-gradient(180deg, #161616 0%, #111111 100%)',
        'shimmer': 'linear-gradient(90deg, #111111 0%, #1a1a1a 50%, #111111 100%)',
      },

      // Box Shadows
      boxShadow: {
        'glow-accent': '0 0 20px rgba(34, 197, 94, 0.3), 0 0 40px rgba(34, 197, 94, 0.1)',
        'glow-blue': '0 0 20px rgba(59, 130, 246, 0.3), 0 0 40px rgba(59, 130, 246, 0.1)',
        'glow-purple': '0 0 20px rgba(139, 92, 246, 0.3), 0 0 40px rgba(139, 92, 246, 0.1)',
        'glow-sm': '0 0 10px rgba(34, 197, 94, 0.2)',
        'inner-glow': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)',
        'card-hover': '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.2)',
      },

      // Backdrop Blur
      backdropBlur: {
        xs: '2px',
      },

      // Animation
      animation: {
        'fade-in': 'fadeIn 300ms ease-out',
        'slide-up': 'slideUp 300ms ease-out',
        'slide-in': 'slideIn 300ms ease-out',
        'scale-in': 'scaleIn 300ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'gentle-pulse': 'gentlePulse 2s ease-in-out infinite',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
        'gradient-border': 'gradientBorder 3s ease infinite',
        'float': 'float 3s ease-in-out infinite',
        'count-pop': 'countPop 300ms ease-out',
        'progress-fill': 'progressFill 500ms ease-out',
      },

      // Keyframes
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideIn: {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        gentlePulse: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.7', transform: 'scale(1.05)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 5px rgba(34, 197, 94, 0.3), 0 0 10px rgba(34, 197, 94, 0.2)' },
          '50%': { boxShadow: '0 0 10px rgba(34, 197, 94, 0.5), 0 0 20px rgba(34, 197, 94, 0.3)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        gradientBorder: {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        countPop: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.05)' },
          '100%': { transform: 'scale(1)' },
        },
        progressFill: {
          '0%': { width: '0%' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' },
        },
      },

      // Spacing
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '112': '28rem',
        '128': '32rem',
      },

      // Border Radius
      borderRadius: {
        '4xl': '2rem',
      },

      // Transition
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-out-expo': 'cubic-bezier(0.65, 0, 0.35, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },

      // Font Size
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.75rem' }],
      },
    },
  },
  plugins: [],
}
