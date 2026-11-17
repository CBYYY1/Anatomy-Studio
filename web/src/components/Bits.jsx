import { useMemo } from "react";
import { motion } from "framer-motion";
import { cssVar } from "../lib/theme";

/** 渐变进度环：Apple Watch 三环的观感，但只做单环。 */
export function Ring({ value = 0, size = 132, stroke = 10, tone = "blue", label, sub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  // 取真实计算色（主题切换后重渲染会重新读一遍）
  const tones = useMemo(
    () => ({
      blue: [cssVar("apple-blue"), cssVar("apple-teal")],
      green: [cssVar("apple-green"), cssVar("apple-teal")],
      red: [cssVar("apple-red"), cssVar("apple-orange")],
      purple: [cssVar("apple-purple"), cssVar("apple-blue")],
    }),
    []
  );
  const [a, b] = tones[tone] || tones.blue;
  const gid = `ring-${tone}`;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={a} />
            <stop offset="100%" stopColor={b} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgb(var(--ink-950) / .1)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ type: "spring", stiffness: 60, damping: 18 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[26px] font-semibold leading-none tabular-nums">
          {Math.round(pct * 100)}
          <span className="ml-0.5 text-[13px] text-ink-900/48">%</span>
        </span>
        {label && <span className="mt-1.5 text-[11px] text-ink-900/48">{label}</span>}
        {sub && <span className="text-[10.5px] text-ink-900/36">{sub}</span>}
      </div>
    </div>
  );
}

/** Bento 里的大数字卡片。 */
export function Stat({ label, value, suffix, tone = "white", hint, icon: Icon, className = "" }) {
  const tones = {
    white: "text-ink-900",
    green: "text-apple-green",
    red: "text-apple-red",
    yellow: "text-apple-yellow",
    blue: "text-apple-blue",
  };
  return (
    <div className={`card card-hover flex flex-col justify-between ${className}`}>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {Icon && <Icon className="h-3.5 w-3.5 text-ink-900/36" />}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className={`stat-num ${tones[tone] || tones.white}`}>{value}</span>
        {suffix && <span className="text-[13px] text-ink-900/44">{suffix}</span>}
      </div>
      {hint && <p className="mt-1.5 text-[11.5px] leading-snug text-ink-900/44">{hint}</p>}
    </div>
  );
}

/** 14 天热力格：7 列 × 2 行，和日历一周对齐。 */
export function Heat({ daily, days = 14 }) {
  const cells = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const rec = daily[key] || { n: 0, ok: 0 };
    cells.push({ key, n: rec.n || 0, ok: rec.ok || 0, wd: d.getDay() });
  }
  const peak = Math.max(1, ...cells.map((c) => c.n));

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((c) => {
          const t = c.n / peak;
          const bg = c.n
            ? `rgb(var(--apple-green) / ${0.22 + t * 0.68})`
            : "rgb(var(--ink-950) / .05)";
          return (
            <div
              key={c.key}
              title={`${c.key}：${c.n} 题 / 对 ${c.ok}`}
              className="aspect-square rounded-[7px] ring-1 ring-inset ring-ink-950/[0.06] transition-transform hover:scale-110"
              style={{ background: bg }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10.5px] text-ink-900/36">
        <span>{cells[0]?.key.slice(5)}</span>
        <span>峰值 {peak === 1 && cells.every((c) => !c.n) ? "—" : `${peak} 题/天`}</span>
        <span>今天</span>
      </div>
    </div>
  );
}

/** 水平条：用于章节正确率 / 错题分布。 */
export function Bar({ value, max = 1, tone = "blue", height = 6 }) {
  const tones = {
    blue: "from-apple-blue to-apple-teal",
    green: "from-apple-green to-apple-teal",
    red: "from-apple-red to-apple-orange",
    yellow: "from-apple-yellow to-apple-orange",
  };
  return (
    <div className="w-full overflow-hidden rounded-full bg-ink-950/[0.07]" style={{ height }}>
      <motion.div
        className={`h-full rounded-full bg-gradient-to-r ${tones[tone] || tones.blue}`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, (value / (max || 1)) * 100)}%` }}
        transition={{ type: "spring", stiffness: 90, damping: 22 }}
      />
    </div>
  );
}
