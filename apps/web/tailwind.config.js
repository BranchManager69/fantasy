/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{ts,tsx,js,jsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
      },
      colors: {
        background: "var(--bg)",
        accent: "var(--accent)",
        "accent-warn": "var(--accent-warn)",
        "text-primary": "var(--text-primary)",
        "text-muted": "var(--text-muted)",
      },
    },
  },
  plugins: [],
};
