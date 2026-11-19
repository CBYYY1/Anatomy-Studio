import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight, ChevronDown, ChevronRight, Flame, Play, Star, TrendingDown, X, Zap,
} from "lucide-react";
import { useStore } from "../store";

/**
 * 错题概览弹窗/抽屉
 * 列出所有 error_count >= 1 的题目（题干摘要、所属章节标签、累计错误次数、当前连对次数），
 * 支持按错误次数降序 / 最近出错时间排序、按章节筛选；
 * 点击任意一道错题可直接跳转做该题，顶部提供「一键练习全部错题」按钮。
 */
export function WrongOverviewModal({ open, onClose, go }) {
  const { list, progress, flash } = useStore();
  const [sortBy, setSortBy] = useState("error_desc"); // error_desc | recent
  const [chapter, setChapter] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const allWrong = useMemo(() => {
    const qmap = new Map(list.map((q) => [q.id, q]));
    const rows = [];
    for (const [id, r] of Object.entries(progress.questions || {})) {
      const err = r.error_count || 0;
      if (err < 1) continue;
      const q = qmap.get(id);
      if (!q) continue;
      rows.push({
        id,
        stem: q.stem,
        chapter: q.chapter,
        type: q.type,
        error_count: err,
        consecutive_correct: r.consecutive_correct || 0,
        starred: !!r.starred,
        last: r.last || 0,
      });
    }
    return rows;
  }, [list, progress.questions]);

  const chapters = useMemo(() => {
    const acc = new Map();
    for (const w of allWrong) {
      acc.set(w.chapter, (acc.get(w.chapter) || 0) + 1);
    }
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [allWrong]);

  const filtered = useMemo(() => {
    const base = chapter ? allWrong.filter((w) => w.chapter === chapter) : [...allWrong];
    if (sortBy === "recent") {
      base.sort((a, b) => b.last - a.last || b.error_count - a.error_count);
    } else {
      base.sort((a, b) => b.error_count - a.error_count || b.last - a.last);
    }
    return base;
  }, [allWrong, chapter, sortBy]);

  if (!open) return null;

  const practiceAll = () => {
    if (!filtered.length) {
      flash("当前没有可练习的错题");
      return;
    }
    try {
      sessionStorage.setItem("cram_ids", JSON.stringify(filtered.map((x) => x.id)));
    } catch { /* ignore */ }
    onClose?.();
    go("practice");
  };

  const practiceOne = (id) => {
    try {
      sessionStorage.setItem("library_ids", JSON.stringify(filtered.map((x) => x.id)));
    } catch { /* ignore */ }
    onClose?.();
    go("practice", id);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-wrong-modal="1"
    >
      <div
        className="absolute inset-0 scrim-45 backdrop-blur-md"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="relative flex max-h-[84vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-ink-950/10 bg-white shadow-bento"
      >
        {/* 头部 */}
        <header className="flex flex-wrap items-center gap-3 border-b border-ink-950/8 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-apple-red/12 text-apple-red">
              <TrendingDown className="h-3.5 w-3.5" />
            </span>
            <div>
              <h2 className="text-[15.5px] font-semibold tracking-tight">
                错题存量概览
              </h2>
              <p className="text-[11px] text-ink-900/44">
                共 {allWrong.length} 道错题{chapter ? ` · 当前章节 ${filtered.length} 道` : ""}
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={practiceAll}
              disabled={!filtered.length}
              className="btn-primary px-3.5 py-1.5 text-[12px] disabled:opacity-45"
            >
              <Play className="h-3 w-3" />
              一键练习全部错题（{filtered.length}）
            </button>
            <button
              onClick={onClose}
              className="btn-ghost px-2 py-1.5"
              title="关闭 (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* 筛选与排序栏 */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-ink-950/8 bg-ink-950/[0.018] px-5 py-2.5">
          <div className="relative">
            <select
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              className="appearance-none rounded-full border border-ink-950/10 bg-white py-1.5 pl-3 pr-8 text-[12px] text-ink-900/78 outline-none transition-colors hover:border-ink-950/22 focus:border-apple-blue/60"
            >
              <option value="">全部章节（{allWrong.length}）</option>
              {chapters.map(([c, cnt]) => (
                <option key={c} value={c}>
                  {c}（{cnt}）
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-900/44" />
          </div>

          <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.04] p-0.5">
            {[
              ["error_desc", "按错误次数降序"],
              ["recent", "按最近出错时间"],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSortBy(k)}
                className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  sortBy === k
                    ? "bg-white text-ink-900 shadow-sm"
                    : "text-ink-900/52 hover:text-ink-900/78"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="ml-auto text-[11.5px] text-ink-900/40">
            点击任意题目直接跳转练习
          </span>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 divide-y divide-ink-950/[0.06] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-ink-900/40">
              当前还没有错题记录
            </div>
          ) : (
            filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => practiceOne(item.id)}
                className="group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-ink-950/[0.035]"
              >
                <span className="mt-0.5 shrink-0 rounded-lg border border-apple-red/25 bg-apple-red/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-apple-red">
                  错 {item.error_count} 次
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-900/82 group-hover:text-ink-900">
                    {item.stem}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded-md bg-ink-950/[0.05] px-1.5 py-0.5 text-ink-900/56">
                      {item.chapter}
                    </span>
                    <span className="tabular-nums text-ink-900/44">
                      连对 {item.consecutive_correct} 次
                    </span>
                    {item.starred && (
                      <Star className="h-3 w-3 text-apple-yellow" fill="currentColor" />
                    )}
                    {item.last > 0 && (
                      <span className="text-ink-900/32">
                        · {new Date(item.last * 1000).toLocaleDateString("zh-CN")}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-900/28 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-900/70" />
              </button>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * 考前突击队列完整概览弹窗/抽屉
 * 按优先级权重（P18、P14 等）从高到低展示队列中的全部题目，
 * 支持章节筛选、快捷题量选择，点击任意条目可直接跳转单题练习。
 */
export function CramOverviewModal({ open, onClose, go, defaultLimit = "50" }) {
  const { cramItems, quiz, flash } = useStore();
  const [chapter, setChapter] = useState("");
  const [limit, setLimit] = useState(defaultLimit); // "20" | "50" | "100" | "all"

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const chapters = useMemo(() => {
    const acc = new Map();
    for (const c of cramItems) {
      acc.set(c.chapter, (acc.get(c.chapter) || 0) + 1);
    }
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [cramItems]);

  const filtered = useMemo(
    () => (chapter ? cramItems.filter((c) => c.chapter === chapter) : cramItems),
    [cramItems, chapter]
  );

  if (!open) return null;

  const rescueCount =
    limit === "all"
      ? filtered.length
      : Math.min(Number(limit) || 50, filtered.length);

  const startRescue = () => {
    if (!filtered.length) {
      flash("急救池是空的，目前没有需要抢救的题目");
      return;
    }
    const picked = limit === "all" ? filtered : filtered.slice(0, Number(limit) || 50);
    try {
      sessionStorage.setItem("cram_ids", JSON.stringify(picked.map((x) => x.id)));
    } catch { /* ignore */ }
    onClose?.();
    go("practice");
  };

  const practiceOne = (id) => {
    try {
      sessionStorage.setItem("cram_ids", JSON.stringify(filtered.map((x) => x.id)));
    } catch { /* ignore */ }
    onClose?.();
    go("practice", id);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-cram-modal="1"
    >
      <div
        className="absolute inset-0 scrim-45 backdrop-blur-md"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="relative flex max-h-[84vh] w-full max-w-[780px] flex-col overflow-hidden rounded-[22px] border border-ink-950/10 bg-white shadow-bento"
      >
        {/* 头部 */}
        <header className="flex flex-wrap items-center gap-3 border-b border-ink-950/8 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-apple-yellow/15 text-apple-yellow">
              <Zap className="h-3.5 w-3.5" />
            </span>
            <div>
              <h2 className="text-[15.5px] font-semibold tracking-tight">
                考前突击队列完整概览
              </h2>
              <p className="text-[11px] text-ink-900/44">
                共 {cramItems.length} 道待抢救 · 权重 = 错误次数 × 2 − 连对 + 收藏加成（连对 {quiz?.cram_mastery_streak || 3} 次自动毕业）
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={startRescue}
              disabled={!filtered.length}
              className="btn-primary px-3.5 py-1.5 text-[12px] disabled:opacity-45"
            >
              <Flame className="h-3.5 w-3.5" />
              抢救 {rescueCount} 个死角
            </button>
            <button
              onClick={onClose}
              className="btn-ghost px-2 py-1.5"
              title="关闭 (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* 筛选与单次题量栏 */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-ink-950/8 bg-ink-950/[0.018] px-5 py-2.5">
          <div className="relative">
            <select
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              className="appearance-none rounded-full border border-ink-950/10 bg-white py-1.5 pl-3 pr-8 text-[12px] text-ink-900/78 outline-none transition-colors hover:border-ink-950/22 focus:border-apple-blue/60"
            >
              <option value="">全部章节（{cramItems.length}）</option>
              {chapters.map(([c, cnt]) => (
                <option key={c} value={c}>
                  {c}（{cnt}）
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-900/44" />
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] text-ink-900/44">单次抢救题量：</span>
            <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.04] p-0.5">
              {[
                ["20", "20 题"],
                ["50", "50 题"],
                ["100", "100 题"],
                ["all", `全部 (${filtered.length})`],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setLimit(k)}
                  className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    limit === k
                      ? "bg-white text-ink-900 shadow-sm"
                      : "text-ink-900/52 hover:text-ink-900/78"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <span className="ml-auto text-[11.5px] text-ink-900/40">
            按优先级权重降序排列
          </span>
        </div>

        {/* 队列列表 */}
        <div className="min-h-0 flex-1 divide-y divide-ink-950/[0.06] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-ink-900/40">
              急救池是空的 —— 目前没有需要抢救的题目
            </div>
          ) : (
            filtered.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => practiceOne(item.id)}
                className="group flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-ink-950/[0.035]"
              >
                <span className="mt-0.5 w-8 shrink-0 font-mono text-[11px] tabular-nums text-ink-900/32">
                  #{idx + 1}
                </span>
                <span className="mt-0.5 shrink-0 rounded-lg border border-apple-red/25 bg-apple-red/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-apple-red">
                  P{item.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-900/82 group-hover:text-ink-900">
                    {item.stem}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded-md bg-ink-950/[0.05] px-1.5 py-0.5 text-ink-900/56">
                      {item.chapter}
                    </span>
                    <span className="tabular-nums text-apple-red/75">
                      错 {item.error_count} 次
                    </span>
                    <span className="tabular-nums text-ink-900/44">
                      连对 {item.consecutive_correct} 次
                    </span>
                    {item.starred && (
                      <span className="inline-flex items-center gap-0.5 text-apple-yellow">
                        <Star className="h-3 w-3" fill="currentColor" />
                        收藏
                      </span>
                    )}
                  </div>
                </div>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-900/28 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-900/70" />
              </button>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
