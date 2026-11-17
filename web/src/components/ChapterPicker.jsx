import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Layers, X } from "lucide-react";

/**
 * 两级章节多选器
 *
 * 题库原始分类是「篇 → 章」两层（第一篇 运动系统 → 骨和骨连结 / 肌学），
 * 而 questions.json 的 chapter 只有叶子名，同名叶子会跨篇出现（「总论」就有三个），
 * 所以选择结果用 group + chapter 的组合作为唯一键：`运动系统/肌学`。
 *
 * value 形状：{ group: string, chapters: string[] }，空 chapters 表示该篇全选。
 * 对外仍然给出扁平的 selected 列表供筛选使用。
 */
export function keyOf(group, chapter) {
  return group ? `${group}/${chapter}` : chapter;
}

export default function ChapterPicker({ groups, value, onChange, allLabel = "全部章节" }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0, width: 420 });

  const selected = value || { group: "", chapters: [] };
  const selSet = useMemo(() => new Set(selected.chapters || []), [selected.chapters]);

  // 已选章（含篇名）用于按钮上的摘要
  const label = useMemo(() => {
    const n = selSet.size;
    if (!n) return allLabel;
    if (n === 1) return [...selSet][0].split("/").pop();
    return `已选 ${n} 个章节`;
  }, [selSet, allLabel]);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(560, Math.max(360, r.width + 220));
    const left = Math.min(r.left, Math.max(12, window.innerWidth - width - 12));
    const below = window.innerHeight - r.bottom;
    const top = below < 360 ? Math.max(12, r.top - 372) : r.bottom + 6;
    setPos({ left, top, width });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggle = (group, chapter) => {
    const k = keyOf(group, chapter);
    const next = new Set(selSet);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange({ group: "", chapters: [...next] });
  };

  const toggleGroup = (g) => {
    const keys = (g.chapters || []).map((c) => keyOf(g.name, c.name));
    const allOn = keys.every((k) => selSet.has(k));
    const next = new Set(selSet);
    if (allOn) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
    onChange({ group: "", chapters: [...next] });
  };

  const clearAll = () => onChange({ group: "", chapters: [] });

  const totalPicked = selSet.size;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-[12.5px] transition-colors ${
          totalPicked
            ? "border-apple-blue/40 bg-apple-blue/10 text-apple-blue"
            : "border-ink-950/10 bg-ink-950/[0.04] text-ink-900/62 hover:border-ink-950/20"
        }`}
        title="按「篇 → 章」勾选，可多选"
        data-chapter-picker="1"
      >
        <Layers className="h-3.5 w-3.5" />
        {label}
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
            <AnimatePresence>
              <motion.div
                key="chapter-pop"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, zIndex: 90 }}
                className="max-h-[368px] overflow-y-auto rounded-[18px] border border-ink-950/10 bg-white p-3 shadow-bento"
                data-chapter-pop="1"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="label">按篇勾选 · 可多选</span>
                  <button
                    onClick={clearAll}
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] text-ink-900/40 hover:bg-ink-950/[0.05] hover:text-ink-900/70"
                  >
                    <X className="h-3 w-3" /> 清空
                  </button>
                </div>

                {groups.map((g) => {
                  const keys = (g.chapters || []).map((c) => keyOf(g.name, c.name));
                  const on = keys.filter((k) => selSet.has(k)).length;
                  const allOn = keys.length > 0 && on === keys.length;
                  return (
                    <div key={g.name} className="mb-2 last:mb-0" data-group-row="1">
                      <button
                        onClick={() => toggleGroup(g)}
                        className="mb-1 flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-ink-950/[0.04]"
                      >
                        <span
                          className={`flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border transition-colors ${
                            allOn
                              ? "border-apple-blue bg-apple-blue text-white"
                              : on > 0
                              ? "border-apple-blue/50 bg-apple-blue/15 text-apple-blue"
                              : "border-ink-950/18 text-transparent"
                          }`}
                        >
                          {allOn ? <Check className="h-3 w-3" /> : on > 0 ? "–" : ""}
                        </span>
                        <span className="text-[12.5px] font-semibold text-ink-900/82">{g.name}</span>
                        <span className="text-[11px] tabular-nums text-ink-900/34">
                          {on}/{keys.length} · {g.count} 题
                        </span>
                      </button>
                      <div className="flex flex-wrap gap-1 pl-6">
                        {(g.chapters || []).map((c) => {
                          const k = keyOf(g.name, c.name);
                          const on2 = selSet.has(k);
                          return (
                            <button
                              key={k}
                              onClick={() => toggle(g.name, c.name)}
                              data-chip="1"
                              className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                                on2
                                  ? "border-apple-blue/45 bg-apple-blue/12 font-medium text-apple-blue"
                                  : "border-ink-950/10 text-ink-900/56 hover:border-ink-950/22 hover:text-ink-900/80"
                              }`}
                              title={`${c.count} 题`}
                            >
                              {c.name}
                              <span className="ml-1 tabular-nums opacity-50">{c.count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </AnimatePresence>
          </>,
          document.body
        )}
    </>
  );
}
