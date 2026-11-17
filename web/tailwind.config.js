/** @type {import('tailwindcss').Config} */

// 设计稿里大量使用 /8 /12 /72 这种精细透明度，
// 默认 opacity 刻度只有 0/5/10/20…，直接写会报 "class does not exist"。
// 这里把 1–100 全部补齐，`text-ink-900/72`、`border-ink-950/8` 才能用。
const OPACITY = Object.fromEntries(
  Array.from({ length: 100 }, (_, i) => [i + 1, String((i + 1) / 100)])
);

// 颜色全部挂在 CSS 变量上（见 src/index.css 的 [data-theme] 段）。
// 这样同一套 JSX 类名可以同时支持「深空暗黑 / OLED 纯黑 / 纸质浅色」——
// `bg-white` 在浅色主题是白卡片，在暗黑主题是 #1C1C1E 的表面色；
// `text-ink-900/62` 在浅色是 62% 的墨，在暗黑是 62% 的浅灰。不用改组件。
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      opacity: OPACITY,
      colors: {
        ink: {
          950: v("ink-950"),
          900: v("ink-900"),
          850: v("ink-850"),
          800: v("ink-800"),
          750: v("ink-750"),
          700: v("ink-700"),
          600: v("ink-600"),
          500: v("ink-500"),
        },
        white: v("white"),
        black: v("black"),
        apple: {
          green: v("apple-green"),
          red: v("apple-red"),
          yellow: v("apple-yellow"),
          blue: v("apple-blue"),
          teal: v("apple-teal"),
          purple: v("apple-purple"),
          orange: v("apple-orange"),
        },
      },
      fontFamily: {
        sans: [
          "Inter", "-apple-system", "SF Pro Display", "Segoe UI",
          "PingFang SC", "Microsoft YaHei", "sans-serif",
        ],
        mono: ["SF Mono", "JetBrains Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        bento: "var(--shadow-bento)",
        glow: "0 0 32px -10px rgb(var(--apple-blue) / .28)",
      },
      backdropBlur: { xs: "2px" },
      transitionTimingFunction: {
        spring: "cubic-bezier(.22,1.2,.36,1)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: 0, transform: "translateY(12px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "fade-up": "fade-up .5s cubic-bezier(.22,1.2,.36,1) both",
        shimmer: "shimmer 3s linear infinite",
      },
    },
  },
  plugins: [],
};
