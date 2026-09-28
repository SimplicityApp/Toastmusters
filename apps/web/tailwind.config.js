/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Shared components live outside this app's src tree; without this glob
    // every Tailwind class in them is purged from this build and they render
    // unstyled with no error. See packages/ui/README.md.
    "../../packages/ui/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        'timer-green': '#10b981',
        'timer-yellow': '#f59e0b',
        'timer-red': '#ef4444',
        // Landing page palette: warm paper background with near-black ink,
        // so the green/yellow/red signal colors stay the loudest thing on it.
        cream: '#FAF7F2',
        ink: '#1C1B1A',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
