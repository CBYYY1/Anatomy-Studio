import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Image as ImageIcon, Search, Star, X } from "lucide-react";
import { useStore } from "../store";
import ChapterPicker from "../components/ChapterPicker";

const PAGE = 60;

export default function LibraryView({ go }) {
  const { list, progress, meta } = useStore();
  const [kw, setKw] = useState("");
  const [chapter, setChapter] = useState([]);     // 多选："运动系统/肌学" 等组合键
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);

  // 两级章节树（篇 → 章）；后端没给就现场聚合
  const groups = useMemo(() => {
    if (meta?.groups?.length) return meta.groups;
    const acc = new Map();
    for (const q of list) {
      const g = q.group || "人体解剖学";
      if (!acc.has(g)) acc.set(g, new Map());
      const m = acc.get(g);
      m.set(q.chapter, (m.get(q.chapter) || 0) + 1);
    }
    return [...acc.entries()].map(([name, m]) => ({
      name,
      count: [...m.values()].reduce((a, b) => a + b, 0),
      chapters: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ name: c, count: n })),
    }));
  }, [meta?.groups, list]);

  const rows = useMemo(() => {
    const k = kw.trim();
    const wanted = chapter || [];
    const out = list.filter((q) => {
      if (wanted.length) {
        const combo = q.group ? `${q.group}/${q.chapter}` : q.chapter;
        if (!wanted.includes(combo) && !wanted.includes(q.chapter)) return false;
      }
      if (type && q.type !== type) return false;
      if (!k) return true;
      return q.stem.includes(k) || (q.keywords || []).some((x) => x.includes(k));
    });
    return out;
  }, [list, kw, chapter, type]);

  // 搜索条件变了就回到第一页，避免停在一个空页上
  const visible = rows.slice(0, page * PAGE);

  return (
    <div className="space-y-4">
      <section className="pb-1 pt-2">
        <p className="label mb-1.5">题库</p>
        <h1 className="text-[34px] font-semibold tracking-[-0.02em]">
          {meta?.total} 道真题
          <span className="text-ink-900/40"> · 每道都挂着 Obsidian 证据</span>
        </h1>
      </section>

      <div className="card">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-900/36" />
            <input
              id="lq"
              value={kw}
              onChange={(e) => {
                setKw(e.target.value);
                setPage(1);
              }}
              placeholder="搜题干或知识点，例如：面神经 / 三叉神经 / 股骨颈"
              className="w-full rounded-full border border-ink-950/10 bg-ink-950/[0.04] py-2 pl-9 pr-9 text-[13px] text-ink-900/82 outline-none transition-colors placeholder:text-ink-900/32 hover:border-ink-950/20 focus:border-apple-blue/60"
            />
            {kw && (
              <button
                onClick={() => setKw("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-900/36 hover:text-ink-900/66"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <ChapterPicker
            groups={groups}
            value={{ chapters: chapter }}
            onChange={(v) => {
              setChapter(v.chapters);
              setPage(1);
            }}
          />
          <Sel
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={[["", "全部题型"], ["single", "单选"], ["multiple", "多选"]]}
          />

          <span className="ml-auto text-[12px] tabular-nums text-ink-900/40">
            {rows.length} 题
          </span>
        </div>
      </div>

      <div className="card p-0">
        <div className="divide-y divide-ink-950/[0.055]">
          {visible.map((q, idx) => {
            const r = progress.questions[q.id];
            return (
              <motion.button
                key={q.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(idx, 12) * 0.008 }}
                onClick={() => {
                  // 把这批筛选结果整列带过去，题库里点题也能顺着做下一题
                  try {
                    sessionStorage.setItem("library_ids", JSON.stringify(rows.map((x) => x.id)));
                  } catch {
                    /* 存不了就退回单题深链 */
                  }
                  go("practice", q.id);
                }}
                className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-950/[0.04]"
              >
                <span className="mt-0.5 w-[76px] shrink-0 font-mono text-[10.5px] text-ink-900/32">
                  {q.id.replace("anat_", "#")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-[13.5px] leading-relaxed text-ink-900/78 group-hover:text-ink-900/95">
                    {q.stem}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] text-ink-900/36">{q.chapter}</span>
                    {q.type === "multiple" && (
                      <span className="rounded bg-apple-yellow/12 px-1.5 py-0.5 text-[10px] text-apple-yellow/80">
                        多选
                      </span>
                    )}
                    {r?.starred && <Star className="h-2.5 w-2.5 text-apple-yellow" fill="currentColor" />}
                    {r?.error_count > 0 && (
                      <span className="text-[10px] text-apple-red/70">错 {r.error_count}</span>
                    )}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-ink-900/36">
                  {(q.answer || []).join("") || "—"}
                </span>
              </motion.button>
            );
          })}
        </div>

        {visible.length < rows.length && (
          <div className="border-t border-ink-950/8 p-3 text-center">
            <button className="btn-ghost px-4 py-1.5 text-[12px]" onClick={() => setPage((p) => p + 1)}>
              再加载 {Math.min(PAGE, rows.length - visible.length)} 题
            </button>
          </div>
        )}

        {rows.length === 0 && (
          <div className="py-20 text-center text-[13px] text-ink-900/36">
            没有匹配的题 —— 换个关键词试试
          </div>
        )}
      </div>
    </div>
  );
}

function Sel({ value, onChange, options }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-full border border-ink-950/10 bg-ink-950/[0.04] py-2 pl-3 pr-8 text-[12.5px] text-ink-900/74 outline-none transition-colors hover:border-ink-950/20 focus:border-apple-blue/60"
      >
        {options.map(([v, label]) => (
          <option key={v} value={v} className="bg-white">
            {label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-900/44" />
    </div>
  );
}
