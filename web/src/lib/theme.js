/** 读取当前主题的 CSS 变量，供 ECharts / SVG 这类必须拿具体颜色值的地方用。 */
export function cssVar(name, alpha = 1) {
  if (typeof window === "undefined") return "#000";
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();
  if (!raw) return "#000";
  const parts = raw.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
  if (parts.length >= 3) {
    return alpha >= 1 ? `rgb(${parts[0]},${parts[1]},${parts[2]})` : `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  return raw;
}

/** rgb(var(--x) / a) 的 JS 版本，用于暗/亮两套主题下都能读的发光色。 */
export function tone(name) {
  return {
    solid: cssVar(name, 1),
    soft: cssVar(name, 0.18),
    glow: cssVar(name, 0.45),
  };
}
