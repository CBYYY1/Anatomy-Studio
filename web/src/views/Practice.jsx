import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Layers, ListOrdered, Loader2,
  RotateCcw, Shuffle, Sparkles, Star, Target, X, Zap,
} from "lucide-react";
import { useStore } from "../store";
import StemText from "../components/StemText";
import NoteDrawer from "../components/NoteDrawer";
import ChapterPicker from "../components/ChapterPicker";
import { api } from "../api";
import { counts } from "../lib/highlight";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const SIZE = 20;

/** 断点续做：只存题号序列与位置，题面从内存里的 list 还原。 */
const RESUME_KEY = "anatomy.practice.v1";

function saveResume(payload) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(payload));
  } catch {
    /* 隐私模式下写不了就算了 */
  }
}

function readResume() {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const MODES = [
  { key: "normal", label: "顺序", icon: Target },
  { key: "random", label: "随机", icon: Shuffle },
  { key: "cram", label: "急救", icon: Zap },
];

/** 按条件筛出一池题（客户端筛选，题库已全量在内存）。
 *
 * chapter 支持数组（多选）：数组里的键既可以是纯章名，也可以是「篇/章」组合键，
 * 后者用于区分跨篇同名章（三个「总论」）。
 */
function chapterMatches(q, chapters) {
  if (!chapters || !chapters.length) return true;
  const plain = q.chapter;
  const combo = q.group ? `${q.group}/${q.chapter}` : plain;
  return chapters.includes(plain) || chapters.includes(combo);
}

function filterPool(list, progress, { module, chapter, type, only, streak = 3 }) {
  const wanted = Array.isArray(chapter) ? chapter : chapter ? [chapter] : [];
  let pool = list.filter((q) => {
    if (module && q.module !== module) return false;
    if (!chapterMatches(q, wanted)) return false;
    if (type && q.type !== type) return false;
    return true;
  });

  if (only === "wrong") {
    pool = pool.filter((q) => (progress.questions[q.id]?.error_count || 0) > 0);
  } else if (only === "star") {
    pool = pool.filter((q) => progress.questions[q.id]?.starred);
  } else if (only === "new") {
    pool = pool.filter((q) => !progress.questions[q.id]?.seen);
  } else if (only === "unmastered") {
    pool = pool.filter(
      (q) => (progress.questions[q.id]?.consecutive_correct || 0) < streak
    );
  }
  return pool;
}

/** 按条件取一组题；size === "all" 表示不截断，整池全取。 */
function buildQueue(list, progress, { module, chapter, type, only, mode, size, streak = 3 }) {
  const pool = filterPool(list, progress, { module, chapter, type, only, streak });

  if (mode === "random" || mode === "cram") {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  if (size === "all") return pool;
  return pool.slice(0, Number(size) || 20);
}

export default function Practice({ go, initialId }) {
  const {
    list, progress, record, toggleStar, flash, stats, meta,
    quiz, llm, settingsOpen,
  } = useStore();

  const [module, setModule] = useState("");
  const [chapter, setChapter] = useState([]);      // 多选：["运动系统/肌学", ...]
  const [type, setType] = useState("");
  const [only, setOnly] = useState("");
  const [mode, setMode] = useState("normal");
  const [size, setSize] = useState(String(SIZE));   // "10" | "20" | "30" | "50" | "all"

  const [queue, setQueue] = useState([]);         // [{id, stem, ...}] 精简
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState([]);
  const [checked, setChecked] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [detail, setDetail] = useState(null);      // 完整题
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState({ n: 0, ok: 0 });
  const [result, setResult] = useState(null);      // {ok}
  const [busy, setBusy] = useState(false);

  const nextRef = useRef(null);        // 供「答对自动下一题」的定时器调用
  const autoTimer = useRef(null);      // 自动切题的待执行定时器（用户一动手就取消）
  const resumed = useRef(false);       // 断点续做只还原一次
  const [jumpOpen, setJumpOpen] = useState(false);   // 「选题」题号菜单

  const cur = queue[i];
  const isMulti = cur?.type === "multiple";

  const chapters = useMemo(() => {
    const acc = new Map();
    for (const q of list) {
      if (module && q.module !== module) continue;
      acc.set(q.chapter, (acc.get(q.chapter) || 0) + 1);
    }
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [list, module]);

  // 两级章节树（篇 → 章）来自后端 /api/meta；后端没给就现场从 list 聚合一份
  const groups = useMemo(() => {
    if (meta?.groups?.length) return meta.groups;
    const acc = new Map();
    for (const q of list) {
      if (module && q.module !== module) continue;
      const g = q.group || "人体解剖学";
      if (!acc.has(g)) acc.set(g, new Map());
      const m = acc.get(g);
      m.set(q.chapter, (m.get(q.chapter) || 0) + 1);
    }
    return [...acc.entries()].map(([name, m]) => ({
      name,
      count: [...m.values()].reduce((a, b) => a + b, 0),
      chapters: [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => ({ name: c, count: n })),
    }));
  }, [meta?.groups, list, module]);

  // 当前筛选条件下总共有多少题（给「全部习题」选项显示真实题数）
  const poolCount = useMemo(
    () => filterPool(list, progress, {
      module, chapter, type, only, streak: quiz.cram_mastery_streak,
    }).length,
    [list, progress, module, chapter, type, only, quiz.cram_mastery_streak]
  );

  // 从首页突击队列跳进来时，sessionStorage 里带着 id 列表
  useEffect(() => {
    const raw = sessionStorage.getItem("cram_ids");
    if (!raw) return;
    sessionStorage.removeItem("cram_ids");
    try {
      const ids = JSON.parse(raw);
      const qmap = new Map(list.map((q) => [q.id, q]));
      const qs = ids.map((id) => qmap.get(id)).filter(Boolean);
      if (qs.length) {
        setMode("cram");
        setQueue(qs);
        setI(0);
        setPicked([]);
        setChecked(false);
        setSession({ n: 0, ok: 0 });
      }
    } catch {
      /* ignore */
    }
  }, [list]);

  // 从分析页「最该补的章节 · 去练」跳进来时，预设章节并直接出一组题
  useEffect(() => {
    const hint = sessionStorage.getItem("cram_hint");
    if (!hint) return;
    sessionStorage.removeItem("cram_hint");
    const qs = buildQueue(list, progress, {
      module: "", chapter: hint, type: "", only: "", mode: "random", size,
      streak: quiz.cram_mastery_streak,
    });
    if (!qs.length) {
      flash(`「${hint}」这个章节还没有题目`, "bad");
      return;
    }
    setChapter([hint]);
    setOnly("");
    setMode("random");
    setQueue(qs);
    setI(0);
    setPicked([]);
    setChecked(false);
    setShowDrawer(false);
    setSession({ n: 0, ok: 0 });
    setResult(null);
  }, [list, progress, size, flash, quiz.cram_mastery_streak]);

  // 深链 #/practice/anat_xxxx：若来自题库页，则整页结果都带过来，可以顺着做下一题
  useEffect(() => {
    if (!initialId) return;
    let alive = true;

    // 题库页点进来的情况：把当时的筛选结果整列当成本组队列
    const rawIds = sessionStorage.getItem("library_ids");
    if (rawIds) {
      sessionStorage.removeItem("library_ids");
      try {
        const ids = JSON.parse(rawIds);
        const qmap = new Map(list.map((q) => [q.id, q]));
        const qs = ids.map((id) => qmap.get(id)).filter(Boolean);
        const at = qs.findIndex((q) => q.id === initialId);
        if (qs.length > 1 && at >= 0) {
          setModule("");
          setChapter([]);
          setType("");
          setOnly("");
          setMode("normal");
          setQueue(qs);
          setI(at);
          setPicked([]);
          setChecked(false);
          setShowDrawer(false);
          setSession({ n: 0, ok: 0 });
          setResult(null);
          return;
        }
      } catch {
        /* 落回单题深链 */
      }
    }

    (async () => {
      setLoading(true);
      try {
        // 刷新后还在同一道题的深链上：优先还原上一次那一组队列，而不是退化成单题
        const saved = readResume();
        if (saved && Array.isArray(saved.ids) && saved.ids.length > 1) {
          const qmap = new Map(list.map((q) => [q.id, q]));
          const qs = saved.ids.map((id) => qmap.get(id)).filter(Boolean);
          const at = qs.findIndex((q) => q.id === initialId);
          if (qs.length > 1 && at >= 0) {
            // 刷新场景：停在原位；从别处（题库搜索等）深链过来：定位到那道题
            const sameSpot = saved.ids[Math.min(Math.max(0, saved.i | 0), qs.length - 1)] === initialId;
            setMode(saved.mode || "normal");
            setQueue(qs);
            setI(sameSpot ? Math.min(Math.max(0, saved.i | 0), qs.length - 1) : at);
            setPicked([]);
            setChecked(false);
            setShowDrawer(false);
            setSession({ n: 0, ok: saved.ok | 0 });
            setResult(null);
            return;
          }
        }
        const q = await api.question(initialId);
        if (!alive) return;
        setQueue([q]);
        setDetail(q);
        setI(0);
        setPicked([]);
        setChecked(false);
        setSession({ n: 0, ok: 0 });
      } catch (e) {
        flash(`找不到这道题：${e.message}`, "bad");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialId, flash, list]);

  // 断点续做：刷新 / 关掉浏览器再打开，回到原来那一组、原来那道题
  useEffect(() => {
    if (resumed.current) return;
    if (!list.length) return;
    if (initialId) return;                 // 深链优先
    if (sessionStorage.getItem("cram_ids") || sessionStorage.getItem("cram_hint")) return;
    resumed.current = true;
    const saved = readResume();
    if (!saved || !Array.isArray(saved.ids) || saved.ids.length < 2) return;
    const qmap = new Map(list.map((q) => [q.id, q]));
    const qs = saved.ids.map((id) => qmap.get(id)).filter(Boolean);
    if (qs.length < 2) return;
    setQueue(qs);
    setI(Math.min(Math.max(0, saved.i | 0), qs.length - 1));
    setMode(saved.mode || "normal");
    setPicked([]);
    setChecked(false);
    setShowDrawer(false);
    setSession({ n: 0, ok: saved.ok | 0 });
  }, [list, initialId]);

  // 深链（#/practice/anat_xxxx）下，翻题 / 跳题后把地址同步成当前题，
  // 这样刷新回来还能落在同一题；用 replaceState 不触发 hashchange，不会打断渲染
  useEffect(() => {
    if (!cur?.id) return;
    if (!location.hash.startsWith("#/practice/")) return;
    const target = `#/practice/${cur.id}`;
    if (location.hash !== target) {
      try {
        history.replaceState(null, "", target);
      } catch {
        /* ignore */
      }
    }
  }, [cur?.id]);

  // 队列 / 位置变了就记一笔（只存 id，题面从 list 还原）
  useEffect(() => {
    if (!queue.length) return;
    saveResume({
      ids: queue.map((q) => q.id),
      i: Math.min(i, queue.length - 1),
      mode,
      ok: session.ok,
      at: Date.now(),
    });
  }, [queue, i, mode, session.ok]);


  // 切题时预取完整题目（有 option_matrix 时才需要抽屉）
  useEffect(() => {
    if (!cur) return;
    let alive = true;
    setDetail(null);
    api.question(cur.id).then((q) => alive && setDetail(q)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [cur?.id]);

  const start = useCallback(() => {
    const qs = buildQueue(list, progress, {
      module, chapter, type, only, mode, size,
      streak: quiz.cram_mastery_streak,
    });
    if (!qs.length) {
      flash("这个筛选条件下没有题了", "bad");
      return;
    }
    setQueue(qs);
    setI(0);
    setPicked([]);
    setChecked(false);
    setShowDrawer(false);
    setSession({ n: 0, ok: 0 });
    setResult(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [list, progress, module, chapter, type, only, mode, size, flash, quiz.cram_mastery_streak]);

  const pick = useCallback(
    (k) => {
      if (checked || !cur) return;
      if (isMulti) {
        setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k].sort()));
      } else {
        setPicked([k]);
        // 单选点完即判分，和纸笔节奏一致
        setTimeout(() => doCheck([k]), 90);
      }
    },
    [checked, cur, isMulti]
  );

  const doCheck = useCallback(
    async (override) => {
      if (!cur || checked || busy) return;
      const sel = override || picked;
      if (!sel.length) {
        flash("先选一个答案");
        return;
      }
      setBusy(true);
      try {
        const ans = new Set(cur.answer || []);
        const ok = sel.length === ans.size && sel.every((s) => ans.has(s));
        setChecked(true);
        setResult({ ok });
        setSession((s) => ({ n: s.n + 1, ok: s.ok + (ok ? 1 : 0) }));
        await record(cur, sel);
        setShowDrawer(true);
        // 「答对自动下一题」：只对答对生效；延迟期间用户仍可点开解析
        if (ok && quiz.auto_next_on_correct) {
          if (autoTimer.current) window.clearTimeout(autoTimer.current);
          autoTimer.current = window.setTimeout(() => {
            autoTimer.current = null;
            nextRef.current?.();
          }, quiz.auto_next_delay_ms || 800);
        }
      } finally {
        setBusy(false);
      }
    },
    [cur, checked, busy, picked, record, flash, quiz.auto_next_on_correct, quiz.auto_next_delay_ms]
  );

  const next = useCallback(() => {
    if (autoTimer.current) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    setPicked([]);
    setChecked(false);
    setResult(null);
    setShowDrawer(false);
    if (i + 1 >= queue.length) {
      setI(queue.length);      // 超出 → 显示结算
    } else {
      setI(i + 1);
    }
  }, [i, queue.length]);

  nextRef.current = next;

  const prev = useCallback(() => {
    if (autoTimer.current) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    if (i === 0) return;
    setI(i - 1);
    setPicked([]);
    setChecked(false);
    setResult(null);
    setShowDrawer(false);
  }, [i]);

  // 从「选题」面板直接跳到第 idx 题（0 基）
  const jump = useCallback((idx) => {
    if (autoTimer.current) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    setJumpOpen(false);
    setI(Math.max(0, Math.min(idx, queue.length - 1)));
    setPicked([]);
    setChecked(false);
    setResult(null);
    setShowDrawer(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [queue.length]);

  // 键盘：A–E / 1–5 选，Enter 提交/下一题，←/→ 切题，空格看解析
  useEffect(() => {
    if (!quiz.enable_shortcuts) return;
    if (settingsOpen) return;            // 设置面板打开时不抢键
    if (jumpOpen) return;                // 选题面板打开时只用鼠标
    function onKey(e) {
      if (e.defaultPrevented) return;
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toUpperCase();
      if (/^[A-F]$/.test(k)) {
        const idx = LETTERS.indexOf(k);
        if (cur && idx >= 0 && idx < Object.keys(cur.options || {}).length) {
          e.preventDefault();
          pick(k);
        }
        return;
      }
      if (/^[1-6]$/.test(k)) {
        const idx = Number(k) - 1;
        const keys = Object.keys(cur?.options || {}).sort();
        if (keys[idx]) {
          e.preventDefault();
          pick(keys[idx]);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!checked) doCheck();
        else next();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
      if (e.key === " ") {
        e.preventDefault();
        if (checked) setShowDrawer((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, doCheck, next, prev, checked, cur, quiz.enable_shortcuts, settingsOpen, jumpOpen]);

  const optKeys = Object.keys(cur?.options || {}).sort();
  const answered = Object.keys(progress.questions || {}).length;

  // ---------------- 结算页
  if (queue.length && i >= queue.length) {
    const acc = session.n ? Math.round((session.ok / session.n) * 100) : 0;
    return (
      <div className="mx-auto max-w-2xl py-14">
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card p-10 text-center"
        >
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-apple-blue to-apple-green">
            <Check className="h-7 w-7" />
          </div>
          <h2 className="text-[26px] font-semibold tracking-tight">这一组完成了</h2>
          <p className="mt-2 text-[14px] text-ink-900/52">
            共 {session.n} 题 · 答对 {session.ok} 题 · 正确率 {acc}%
          </p>
          <div className="mt-7 flex justify-center gap-3">
            <button className="btn-primary px-5 py-2.5" onClick={start}>
              <RotateCcw className="h-3.5 w-3.5" />
              再来一组
            </button>
            <button className="btn-ghost px-5 py-2.5" onClick={() => go("analysis")}>
              看薄弱点分析
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---------------- 筛选器 */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            value={module}
            onChange={(v) => {
              setModule(v);
              setChapter([]);
            }}
            placeholder="全部模块"
            options={[["", "全部模块"], ...(list.reduce((acc, q) => {
              if (!acc.some((x) => x[0] === q.module)) acc.push([q.module, q.module]);
              return acc;
            }, []))]}
          />
          <ChapterPicker
            groups={groups}
            value={{ chapters: chapter }}
            onChange={(v) => setChapter(v.chapters)}
          />
          <Select
            value={type}
            onChange={setType}
            options={[["", "全部题型"], ["single", "单选"], ["multiple", "多选"]]}
          />
          <Select
            value={only}
            onChange={setOnly}
            options={[
              ["", "范围：全部"],
              ["new", "只练没做过的"],
              ["wrong", "只练错题"],
              ["star", "只练收藏"],
              ["unmastered", "只练未掌握"],
            ]}
          />

          <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.03] p-0.5">
            {MODES.map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.key}
                  onClick={() => setMode(m.key)}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                    mode === m.key ? "bg-ink-950/12 text-ink-900" : "text-ink-900/48 hover:text-ink-900/74"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {m.label}
                </button>
              );
            })}
          </div>

          <Select
            value={String(size)}
            onChange={setSize}
            options={[
              ["10", "10 题"],
              ["20", "20 题"],
              ["30", "30 题"],
              ["50", "50 题"],
              ["all", chapter.length ? `本章节全部习题（${poolCount} 题）` : `当前筛选全部习题（${poolCount} 题）`],
            ]}
          />

          <button className="btn-primary ml-auto px-5 py-2" onClick={start}>
            <Sparkles className="h-3.5 w-3.5" />
            生成一组
          </button>
        </div>
      </div>

      {/* ---------------- 题目区 */}
      {loading && (
        <div className="card flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-ink-900/40" />
        </div>
      )}

      {!loading && !cur && (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <Target className="mb-4 h-9 w-9 text-ink-900/32" />
          <p className="text-[16px] font-medium text-ink-900/74">准备好了</p>
          <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-ink-900/44">
            选好范围，点「生成一组」。一组{" "}
            <b className="text-ink-900/70">{size === "all" ? poolCount : size}</b> 题，答错自动进错题本。
            <br />
            键盘：<kbd className="rounded bg-ink-950/10 px-1.5 py-0.5 text-[11px]">A–E</kbd>{" "}
            选择 ·{" "}
            <kbd className="rounded bg-ink-950/10 px-1.5 py-0.5 text-[11px]">Enter</kbd>{" "}
            提交/下一题 ·{" "}
            <kbd className="rounded bg-ink-950/10 px-1.5 py-0.5 text-[11px]">空格</kbd> 解析
          </p>
        </div>
      )}

      {!loading && cur && (
        <AnimatePresence mode="wait">
          <motion.div
            key={cur.id}
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="card p-6"
          >
            {/* 顶栏 */}
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="chip tabular-nums" data-progress="1">
                {i + 1} / {queue.length}
              </span>
              {queue.length > 1 && (
                <button
                  onClick={() => setJumpOpen(true)}
                  className="chip hover:border-ink-950/22 hover:bg-ink-950/[0.06]"
                  title="跳过若干题，直接选题号"
                >
                  <ListOrdered className="h-3 w-3" />
                  选题
                </button>
              )}
              <span className="chip">{cur.chapter}</span>
              <span
                className={`chip ${
                  isMulti
                    ? "border-apple-yellow/25 bg-apple-yellow/10 text-apple-yellow/90"
                    : ""
                }`}
              >
                {isMulti ? "多选题" : "单选题"}
              </span>
              {cur.negation || counts(cur.stem).neg > 0 ? (
                <span className="chip border-apple-red/25 bg-apple-red/10 text-apple-red/90">
                  否定式题干
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => toggleStar(cur.id)}
                  className={`btn-ghost px-2.5 py-1.5 ${
                    progress.questions[cur.id]?.starred
                      ? "border-apple-yellow/40 text-apple-yellow"
                      : ""
                  }`}
                  title="收藏"
                >
                  <Star
                    className="h-3.5 w-3.5"
                    fill={progress.questions[cur.id]?.starred ? "currentColor" : "none"}
                  />
                </button>
                <span className="text-[11px] text-ink-900/36 tabular-nums">
                  错 {progress.questions[cur.id]?.error_count || 0} · 连对{" "}
                  {progress.questions[cur.id]?.consecutive_correct || 0}
                </span>
              </span>
            </div>

            {/* 进度条 */}
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-950/[0.06]">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-apple-blue to-apple-teal"
                animate={{ width: `${((i + 1) / queue.length) * 100}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 22 }}
              />
            </div>

            {/* 题干 */}
            <div className="mt-6">
              <StemText
            text={cur.stem}
            mode={
              quiz.highlight_mode === "after"
                ? (checked ? "always" : "off")
                : quiz.highlight_mode === "off"
                  ? "off"
                  : "always"
            }
          />
            </div>

            {/* 选项 */}
            <div className="mt-5 space-y-2">
              {optKeys.map((k) => {
                const isPick = picked.includes(k);
                const isAns = (cur.answer || []).includes(k);
                const reveal = checked;
                const tone = reveal
                  ? isAns
                    ? "border-apple-green/45 bg-apple-green/[0.09]"
                    : isPick
                    ? "border-apple-red/45 bg-apple-red/[0.09]"
                    : "border-ink-950/6 bg-ink-950/[0.012] opacity-55"
                  : isPick
                  ? "border-apple-blue/50 bg-apple-blue/[0.10]"
                  : "border-ink-950/10 bg-ink-950/[0.022] hover:border-ink-950/22 hover:bg-ink-950/[0.05]";
                return (
                  <motion.button
                    key={k}
                    onClick={() => pick(k)}
                    disabled={checked}
                    whileTap={{ scale: checked ? 1 : 0.994 }}
                    className={`opt-row ${tone}`}
                  >
                    <span
                      className={`opt-key ${
                        reveal && isAns
                          ? "border-apple-green/50 bg-apple-green/20 text-apple-green"
                          : reveal && isPick
                          ? "border-apple-red/50 bg-apple-red/20 text-apple-red"
                          : isPick
                          ? "border-apple-blue/50 bg-apple-blue/20 text-apple-blue"
                          : ""
                      }`}
                    >
                      {reveal && isAns ? (
                        <Check className="h-3 w-3" />
                      ) : reveal && isPick ? (
                        <X className="h-3 w-3" />
                      ) : (
                        k
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] leading-relaxed text-ink-900/82">
                        {cur.options[k]}
                      </span>

                      {/* 选项级证据条（只对被选项与正确项展示，且片段必须与选项相关） */}
                      {reveal && (isAns || isPick) && (detail?.obsidian_match?.option_matrix?.[k] || "").trim() && (
                        <motion.span
                          data-ev="1"
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="mt-1.5 block border-l-2 border-apple-blue/50 pl-2.5 text-[11.5px] leading-snug text-ink-900/48"
                        >
                          {detail.obsidian_match.option_matrix[k]}
                        </motion.span>
                      )}
                    </span>
                  </motion.button>
                );
              })}
            </div>

            {/* 判分条 */}
            <AnimatePresence>
              {checked && result && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={`mt-5 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${
                    result.ok
                      ? "border-apple-green/30 bg-apple-green/[0.08]"
                      : "border-apple-red/30 bg-apple-red/[0.08]"
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full ${
                      result.ok ? "bg-apple-green/25 text-apple-green" : "bg-apple-red/25 text-apple-red"
                    }`}
                  >
                    {result.ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                  </span>
                  <span className="text-[13.5px] font-semibold">
                    {result.ok ? "正确" : "答案不是这个"}
                  </span>
                  <span className="text-[12.5px] text-ink-900/52">
                    正确答案 {(cur.answer || []).join("、") || "—"}
                    {!result.ok && picked.length ? ` · 你选了 ${picked.join("、")}` : ""}
                  </span>
                  <span className="ml-auto text-[11.5px] text-ink-900/40">
                    按 Enter 下一题
                  </span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 底部操作 */}
            <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-ink-950/8 pt-4">
              <button className="btn-ghost px-3 py-2" onClick={prev} disabled={i === 0}>
                <ArrowLeft className="h-3.5 w-3.5" />
                上一题
              </button>
              {!checked ? (
                <button
                  className="btn-primary px-5 py-2"
                  onClick={() => doCheck()}
                  disabled={busy || picked.length === 0}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  提交答案
                </button>
              ) : (
                <>
                  <button className="btn-primary px-5 py-2" onClick={next}>
                    下一题
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="btn-ghost px-3.5 py-2"
                    onClick={() => setShowDrawer((v) => !v)}
                  >
                    <Layers className="h-3.5 w-3.5" />
                    {showDrawer ? "收起解析" : "看解析"}
                  </button>
                </>
              )}
              <span className="ml-auto text-[11px] text-ink-900/32">
                键盘 A–E / 1–5 选择 · Enter 提交 · 空格看解析
              </span>
            </div>

            {/* 解析抽屉 */}
            <AnimatePresence>
              {checked && showDrawer && detail && (
                <NoteDrawer q={detail} picked={picked} onClose={() => setShowDrawer(false)} />
              )}
            </AnimatePresence>

            {/* 选题面板：按题号直接跳 */}
            <AnimatePresence>
              {jumpOpen && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-40 flex items-center justify-center p-6"
                  onClick={() => setJumpOpen(false)}
                >
                  <div className="absolute inset-0 bg-[rgb(var(--scrim)/0.45)] backdrop-blur-md" />
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={{ type: "spring", stiffness: 340, damping: 30 }}
                    onClick={(e) => e.stopPropagation()}
                    className="relative w-full max-w-[560px] rounded-[20px] border border-ink-950/10 bg-white p-5 shadow-bento"
                  >
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14.5px] font-semibold">选题</h3>
                      <span className="text-[11.5px] text-ink-900/40">
                        共 {queue.length} 题 · 点题号直接跳过去
                      </span>
                      <button
                        onClick={() => setJumpOpen(false)}
                        className="ml-auto btn-ghost px-2 py-1"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-4 max-h-[320px] overflow-y-auto">
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1.5">
                        {queue.map((q, idx) => {
                          const r = progress.questions[q.id];
                          const done = (r?.seen || 0) > 0;
                          const wrong = (r?.error_count || 0) > 0;
                          const active = idx === i;
                          return (
                            <button
                              key={q.id + idx}
                              onClick={() => jump(idx)}
                              title={`${q.chapter} · ${q.stem.slice(0, 40)}`}
                              className={`h-9 rounded-[9px] border text-[11.5px] font-medium tabular-nums transition-colors ${
                                active
                                  ? "border-apple-blue/60 bg-apple-blue/15 text-apple-blue"
                                  : wrong
                                  ? "border-apple-red/30 bg-apple-red/[0.07] text-apple-red/85 hover:border-apple-red/50"
                                  : done
                                  ? "border-apple-green/30 bg-apple-green/[0.07] text-apple-green/85 hover:border-apple-green/50"
                                  : "border-ink-950/10 bg-ink-950/[0.03] text-ink-900/55 hover:border-ink-950/24 hover:text-ink-900/80"
                              }`}
                            >
                              {idx + 1}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="mt-3.5 flex flex-wrap items-center gap-3 text-[10.5px] text-ink-900/36">
                      <span className="flex items-center gap-1">
                        <i className="h-2 w-2 rounded-full bg-apple-red/60" /> 错过
                      </span>
                      <span className="flex items-center gap-1">
                        <i className="h-2 w-2 rounded-full bg-apple-green/60" /> 做过
                      </span>
                      <span className="flex items-center gap-1">
                        <i className="h-2 w-2 rounded-full bg-ink-950/20" /> 没做过
                      </span>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

function Select({ value, onChange, options, placeholder }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-full border border-ink-950/10 bg-ink-950/[0.04] py-1.5 pl-3 pr-8 text-[12.5px] text-ink-900/74 outline-none transition-colors hover:border-ink-950/22 focus:border-apple-blue/60"
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
