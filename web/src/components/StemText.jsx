import { segments } from "../lib/highlight";

/**
 * 题干渲染。
 *   mode="always" 永远高亮；mode="after" 只在判分后高亮；mode="off" 不高亮。
 * 用组件而不是 innerHTML：题干文本不可控，拼字符串会有注入风险。
 */
export default function StemText({ text, mode = "always", size = "lg" }) {
  const cls = size === "lg" ? "stem-lg" : "stem-sm";

  if (mode === "off") {
    return <p className={cls}>{text}</p>;
  }

  const segs = segments(text);
  const hasBug = segs.some((s) => s.kind);

  return (
    <p className={cls}>
      {segs.map((s, i) => {
        if (!s.kind) return <span key={i}>{s.text}</span>;
        const map = {
          neg: { cls: "bug-neg", title: "否定词：这题问的是「不属于/错误」的那一项" },
          dir: { cls: "bug-dir", title: "方位词：解剖学里位置定对错" },
          micro: { cls: "bug-micro", title: "微观层级：光镜/电镜看到的层次不同" },
        };
        const m = map[s.kind];
        return (
          <span key={i} className={m.cls} title={m.title}>
            {s.text}
          </span>
        );
      })}
      {hasBug && (
        <span className="ml-2 inline-flex translate-y-[-1px] items-center gap-1 rounded-full border border-ink-950/10 bg-ink-950/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-ink-900/48">
          已标注
        </span>
      )}
    </p>
  );
}
