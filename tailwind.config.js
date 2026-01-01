/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/dashboard/**/*.{html,txt,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        proton: {
          DEFAULT: '#6d4aff',
          dark: '#5a3dd6',
          light: '#886bff',
        },
      },
      fontFamily: {
        mono: [
          'SF Mono',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
