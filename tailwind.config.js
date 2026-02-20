/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    // frontend/ 有自己的 node_modules，不能用 **/* 通配，否则 Tailwind 会扫描进去
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
