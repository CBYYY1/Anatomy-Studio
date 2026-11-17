import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, Brain, ExternalLink, Image as ImageIcon, KeyRound, Layers,
  Loader2, PenLine, RefreshCw, Sparkles, X, ZoomIn,
} from "lucide-react";
import { api, mediaUrl } from "../api";
import { counts } from "../lib/highlight";
import { prepNote } from "../lib/md";
import NoteMarkdown from "./NoteMarkdown";
import { useStore } from "../store";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

const MODES = [
  ["dual", "✨ 双轨同屏"],
  ["ai", "🎯 靶向破题"],
  ["note", "📚 笔记原文"],
];

/**
 * 双轨解析抽屉
 *   左轨：AI 靶向破题精析（基于你的 Obsidian 笔记做事实锚点）
 *   右轨：Obsidian 笔记原文 / 选项矩阵 / 并排对比 / 图谱灯箱 / 错题印记写回
 *
 * 解析走「按需生成 + 落盘缓存」：第一次打开才调模型，之后秒开。
 * 模型返回的是整段 JSON，直接打字机式吐 JSON 很难看，所以这里等整份结果
 * 回来后再对 key_point 做本地逐字播放——观感一致，逻辑简单得多。
 */
export default function NoteDrawer({ q, picked, onClose }) {
  const { llm, settings, kb, setSettingsOpen, setSettingsSection } = useStore();
  const [mode, setMode] = useState("dual");
  const [tab, setTab] = useState("note");       // note | matrix | compare
  const [obsidian, setObsidian] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [writing, setWriting] = useState(false);
  const [markState, setMarkState] = useState(null);
  const [errCount, setErrCount] = useState(0);

  const [ai, setAi] = useState(q.obsidian_match?.targeted_analysis || null);
  const [loading, setLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [needKey, setNeedKey] = useState(false);   // 未配置 Key 的优雅降级标记
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState(null);   // {configured, model}
  const asked = useRef("");                     // 防止同一题重复自动请求

  // 选项矩阵：AI 版（写回 questions.json）优先于题库里旧版本地脚本生成的文本
  const [aiMatrix, setAiMatrix] = useState(() => q.obsidian_match?.option_matrix || {});
  const [matrixAi, setMatrixAi] = useState(!!q.obsidian_match?.option_matrix_ai);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixMsg, setMatrixMsg] = useState(null);
  const matrixAsked = useRef("");

  const om = q.obsidian_match || {};
  const optKeys = Object.keys(q.options || {}).sort();
  const matrix = aiMatrix;
  const images = om.images || [];
  const noteText = useMemo(() => prepNote(om.raw_markdown_context || ""), [om.raw_markdown_context]);
  const bug = useMemo(() => counts(q.stem), [q.stem]);
  const wrongPicks = useMemo(
    () => picked.filter((k) => !(q.answer || []).includes(k)),
    [picked, q.answer]
  );

  // ---- 灯箱 Esc（捕获阶段停止冒泡，避免连带翻页）
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        ev.preventDefault();
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightbox]);

  useEffect(() => {
    setTab("note");
    setMarkState(null);
    if (!om.matched_note) return;
    let alive = true;
    api.link(om.matched_note)
      .then((r) => alive && setObsidian(r))
      .catch(() => alive && setObsidian(null));
    return () => { alive = false; };
  }, [q.id, om.matched_note]);

  useEffect(() => {
    let alive = true;
    api.progress()
      .then((r) => {
        if (!alive) return;
        const rec = (r.progress.questions || {})[q.id];
        setErrCount(rec?.error_count || 0);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [q.id]);

  useEffect(() => {
    api.analyzeStatus?.().then(setStatus).catch(() => {});
  }, []);

  // ---- 靶向解析：进抽屉就拉，有缓存秒回
  const runAnalyze = useCallback(async (force = false) => {
    // 用户主动点「重新深度剖析」但没配 Key → 不静默跑本地推导，明确告诉他去配
    if (force && !llm?.configured) {
      setNeedKey(true);
      setAiError(null);
      return;
    }
    setLoading(true);
    setAiError(null);
    setNeedKey(false);
    setTyped("");
    try {
      const r = await api.analyze(q.id, force);
      const a = r.analysis;
      setAi(a);
      // 后端会把 AI 版选项矩阵永久写回 questions.json，这里同步到界面
      if (r.option_matrix && Object.keys(r.option_matrix).length) {
        setAiMatrix(r.option_matrix);
        setMatrixAi(!!r.option_matrix_ai || r.source === "llm");
      }
      // 本地逐字播放破题眼（模型是整段返回 JSON，不能直接吐流）
      const text = a.key_point || "";
      let i = 0;
      const tick = setInterval(() => {
        i += 2;
        setTyped(text.slice(0, i));
        if (i >= text.length) clearInterval(tick);
      }, 16);
    } catch (e) {
      const msg = e.message || "生成失败";
      // 后端在没配 Key 时会回 4xx + 引导文字；这不是故障，走「去设置填 Key」的降级提示
      if (/未配置|没配|API ?Key|先填|400|409/i.test(msg)) {
        setNeedKey(true);
      } else {
        setAiError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [q.id, llm?.configured]);

  useEffect(() => {
    if (asked.current === q.id) return;
    asked.current = q.id;
    setAi(q.obsidian_match?.targeted_analysis || null);
    if (q.obsidian_match?.targeted_analysis) {
      setTyped(q.obsidian_match.targeted_analysis.key_point || "");
      return;
    }
    const trigger = settings?.llm?.trigger_mode || "on_wrong";
    if (trigger === "manual") return;            // 仅手动：不自动发请求
    // on_wrong：本地推导不烧 Token，可以直接生成；配了 Key 的话只有答错才自动跑
    if (trigger === "on_wrong" && llm?.configured && !wrongPicks.length) return;
    runAnalyze(false);
  }, [q.id, q.obsidian_match, runAnalyze, settings?.llm?.trigger_mode, llm?.configured, wrongPicks.length]);

  // ---- 选项矩阵：让模型用标准医学知识重写 A–E 的剖析，并永久写回 questions.json
  const runMatrix = useCallback(async (force = true) => {
    if (force && !llm?.configured) {
      setMatrixMsg({ ok: false, text: "还没配置大模型 —— 选项矩阵的 AI 剖析需要它；配好后会自动写回题库，下次秒开。" });
      return;
    }
    setMatrixLoading(true);
    setMatrixMsg(null);
    try {
      const r = await api.analyze(q.id, force);
      const m = r.option_matrix || {};
      if (Object.keys(m).length) {
        setAiMatrix(m);
        setMatrixAi(!!r.option_matrix_ai || r.source === "llm");
        setMatrixMsg({
          ok: true,
          text: r.source === "llm"
            ? "已用 AI 医学知识重写 A–E，并写回本地题库（下次秒开）。"
            : r.option_matrix_ai
            ? "这是之前由 AI 生成并保存的版本。"
            : "题库里只有内置定义，点「AI 重新精析」可获得完整医学剖析。",
        });
      } else {
        setMatrixMsg({ ok: false, text: "模型这次没给出选项矩阵，可以再点一次「AI 重新精析」。" });
      }
    } catch (e) {
      const msg = e.message || "生成失败";
      if (/未配置|没配|API ?Key|先填|400|409/i.test(msg)) {
        setMatrixMsg({ ok: false, text: "还没配置大模型 —— 前往设置 → AI 引擎填入 Key 后即可生成。" });
      } else {
        setMatrixMsg({ ok: false, text: `生成失败：${msg}` });
      }
    } finally {
      setMatrixLoading(false);
    }
  }, [q.id, llm?.configured]);

  // 打开「选项矩阵」时，如果还没有 AI 版就自动触发一次重写。
  // 必须 force=true：缓存里那份「靶向解析」可能没有 option_matrix（或只有旧脚本截的碎片），
  // 直接走缓存会拿到空矩阵。
  useEffect(() => {
    if (tab !== "matrix") return;
    if (matrixAi) return;
    if (matrixAsked.current === q.id) return;
    matrixAsked.current = q.id;
    runMatrix(true);
  }, [tab, matrixAi, q.id, runMatrix]);

  const openSettingsForLLM = () => {
    setSettingsSection?.("llm");
    setSettingsOpen(true);
  };

  async function inject() {
    setWriting(true);
    try {
      const r = await api.markError({ id: q.id });
      setMarkState({ ok: true, action: r.action });
    } catch (e) {
      setMarkState({ ok: false, msg: e.message });
    } finally {
      setWriting(false);
    }
  }

  const filledPills = optKeys.filter((k) => matrix[k]);
  const da = ai?.distractor_analysis || {};
  // 排雷顺序：你选错的排最前，其余按字母
  const distractors = Object.keys(da).sort((a, b) => {
    const wa = wrongPicks.includes(a) ? 0 : 1;
    const wb = wrongPicks.includes(b) ? 0 : 1;
    return wa - wb || a.localeCompare(b);
  });

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 240, damping: 30 }}
      className="overflow-hidden"
    >
      <div className="drawer mt-4 p-5">
        {/* ---- 头部：Apple 分段控制器 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.035] p-0.5">
            {MODES.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setMode(k)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  mode === k ? "bg-white text-ink-900 shadow-sm" : "text-ink-900/52 hover:text-ink-900/74"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {(bug.neg > 0 || bug.dir > 0 || bug.micro > 0) && (
            <span className="chip gap-2">
              {bug.neg > 0 && <b className="text-apple-red">否定 {bug.neg}</b>}
              {bug.dir > 0 && <b className="text-apple-yellow">方位 {bug.dir}</b>}
              {bug.micro > 0 && <b className="text-apple-teal">层级 {bug.micro}</b>}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => runAnalyze(true)}
              disabled={loading}
              title="忽略缓存，让模型重新剖析这道题"
              className="btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              重新深度剖析
            </button>
            {obsidian?.url && obsidian?.available !== false && (
              <a
                href={obsidian.url}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                title="用 obsidian:// 协议唤起本地 Obsidian"
              >
                <ExternalLink className="h-3 w-3" />
                在 Obsidian 中打开
              </a>
            )}
            <button onClick={onClose} className="btn-ghost px-2.5 py-1.5">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ---- 出处 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-900/44">
          <span className="rounded-md bg-ink-950/[0.06] px-2 py-0.5 font-mono text-[10.5px]">
            {om.matched_note || "—"}
          </span>
          <span className="text-ink-900/32">›</span>
          <span className="text-ink-900/62">{om.heading || "（无小节标题）"}</span>
        </div>

        <div
          className={`mt-4 grid gap-4 ${
            mode === "dual" ? "lg:grid-cols-[1.02fr_1fr]" : "grid-cols-1"
          }`}
        >
          {/* ================= 左轨：靶向破题精析 ================= */}
          {(mode === "dual" || mode === "ai") && (
            <div className="min-w-0">
              <p className="label mb-2 flex items-center gap-1.5">
                <Brain className="h-3 w-3" />
                靶向破题精析
                {ai?.source && (
                  <span className="ml-1 normal-case tracking-normal text-[10px] text-ink-900/38">
                    {ai.source === "llm"
                      ? `AI · ${status?.model || "deepseek"}`
                      : ai.source === "local"
                      ? "本地推导 · 未调用大模型"
                      : "缓存"}
                  </span>
                )}
              </p>

              {needKey && (
                <div className="rounded-xl border border-ink-950/10 bg-ink-950/[0.03] px-3.5 py-3 text-[12.5px] text-ink-900/80">
                  <p className="flex items-center gap-1.5 font-medium">
                    <KeyRound className="h-3.5 w-3.5" />
                    还没配置大模型
                  </p>
                  <p className="mt-1 leading-relaxed text-ink-900/62">
                    这道题还没有预生成的靶向解析。去【设置 → AI 引擎】填入自己的
                    API Key 就能让 AI 给你讲这道题；不配也完全能用——右侧的课堂笔记原文、
                    选项矩阵、图谱灯箱都是内置的，不联网也不会空。
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button onClick={openSettingsForLLM} className="btn-primary px-3 py-1.5 text-[12px]">
                      前往设置
                    </button>
                    <button onClick={() => setMode("note")} className="btn-ghost px-3 py-1.5 text-[12px]">
                      就看笔记原文
                    </button>
                  </div>
                </div>
              )}

              {aiError && (
                <div className="rounded-xl border border-apple-red/30 bg-apple-red/8 px-3.5 py-3 text-[12.5px] text-apple-red">
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    生成失败
                  </p>
                  <p className="mt-1 leading-relaxed text-apple-red/85">{aiError}</p>
                  <button onClick={openSettingsForLLM} className="btn-ghost mt-2 px-3 py-1.5 text-[12px]">
                    检查 AI 设置
                  </button>
                </div>
              )}

              {loading && !ai && (
                <div className="ai-card ai-glow space-y-3">
                  <div className="skeleton h-3 w-16" />
                  <div className="skeleton h-4 w-full" />
                  <div className="skeleton h-4 w-[86%]" />
                  <div className="skeleton mt-4 h-3 w-24" />
                  <div className="skeleton h-3.5 w-full" />
                  <div className="skeleton h-3.5 w-[78%]" />
                  <p className="pt-1 text-[11.5px] text-ink-900/40">
                    正在拿你的笔记给这道题做剖析…
                  </p>
                </div>
              )}

              {ai && (
                <div className="ai-card ai-glow max-h-[52vh] overflow-y-auto">
                  {/* 模块 A：破题眼 */}
                  <div className="mb-3">
                    <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-apple-blue">
                      <Sparkles className="h-3 w-3" />
                      破题眼
                    </p>
                    <p className={`text-[13.5px] font-medium leading-[1.8] text-ink-900/92 ${typed && typed.length < (ai.key_point || "").length ? "caret" : ""}`}>
                      {typed || ai.key_point}
                    </p>
                  </div>

                  {/* 模块 B：干扰项排雷 */}
                  {distractors.length > 0 && (
                    <div className="mt-4 border-t border-ink-950/8 pt-3">
                      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-900/45">
                        <Layers className="h-3 w-3" />
                        干扰项排雷
                      </p>
                      <ul className="space-y-2">
                        {distractors.map((k) => {
                          const mine = wrongPicks.includes(k);
                          return (
                            <li
                              key={k}
                              className={`flex gap-2.5 rounded-xl px-2.5 py-2 ${
                                mine ? "bg-apple-red/8" : "bg-ink-950/[0.025]"
                              }`}
                            >
                              <span
                                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                                  mine ? "bg-apple-red/18 text-apple-red" : "bg-ink-950/10 text-ink-900/60"
                                }`}
                              >
                                {k}
                              </span>
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[12px] font-medium text-ink-900/80">
                                    {q.options[k]}
                                  </span>
                                  {mine && (
                                    <span className="rounded-full bg-apple-red/16 px-1.5 py-0.5 text-[10px] font-semibold text-apple-red">
                                      你的错选
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 text-[12px] leading-[1.72] text-ink-900/62">
                                  {da[k]}
                                </p>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* 模块 C：避坑锚点 */}
                  {ai.pitfall_summary && (
                    <div className="mt-3 rounded-xl border border-apple-yellow/35 bg-apple-yellow/[0.09] px-3.5 py-2.5">
                      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-apple-yellow">
                        避坑锚点
                      </p>
                      <p className="text-[12.5px] leading-[1.75] text-ink-900/80">
                        {ai.pitfall_summary}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ================= 右轨：Obsidian 原文溯源 ================= */}
          {(mode === "dual" || mode === "note") && (
            <div className="min-w-0">
              {mode === "dual" && (
                <p className="label mb-2 flex items-center gap-1.5">
                  <ImageIcon className="h-3 w-3" />
                  笔记原文溯源
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.035] p-0.5">
                  {[
                    ["note", "原文"],
                    ["matrix", "选项矩阵"],
                    ["compare", "并排对比"],
                  ].map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setTab(k)}
                      className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                        tab === k ? "bg-white text-ink-900 shadow-sm" : "text-ink-900/52 hover:text-ink-900/74"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-ink-900/36">
                  {matrixAi ? "A–E 已由 AI 逐项剖析" : `${filledPills.length}/${optKeys.length} 项待 AI 精析`}
                  {images.length ? ` · 共 ${images.length} 张图谱` : ""}
                </span>
              </div>

              <div className={`mt-3 grid gap-3 ${images.length ? "lg:grid-cols-[1fr_132px]" : ""}`}>
                <div className="min-w-0">
                  {tab === "note" && (
                    <div className="max-h-[46vh] overflow-y-auto pr-1">
                      <NoteMarkdown text={noteText || "_这道题在笔记里没有定位到正文段落。_"} />
                    </div>
                  )}

                  {tab === "matrix" && (
                    <div>
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-ink-900/40">
                          {matrixAi
                            ? "A–E 全部由大模型按人卫版口径逐项剖析 · 已写回本地题库"
                            : "当前是题库内置文本，点右侧按钮让 AI 重写一遍"}
                        </span>
                        <button
                          onClick={() => runMatrix(true)}
                          disabled={matrixLoading}
                          className="btn-ghost ml-auto px-2.5 py-1 text-[11.5px] disabled:opacity-50"
                          title="让大模型用标准医学知识重写 A–E 每个选项的剖析，并写回本地题库"
                        >
                          <Sparkles className={`h-3 w-3 ${matrixLoading ? "animate-pulse" : ""}`} />
                          AI 重新精析
                        </button>
                      </div>

                      {matrixMsg && (
                        <p className={`mb-2.5 rounded-xl px-3 py-2 text-[11.5px] leading-[1.6] ${
                          matrixMsg.ok
                            ? "bg-apple-green/[0.08] text-apple-green"
                            : "bg-apple-yellow/[0.1] text-apple-yellow"
                        }`}>
                          {matrixMsg.text}
                        </p>
                      )}

                      <div className="max-h-[40vh] space-y-2 overflow-y-auto pr-1">
                        {matrixLoading && !filledPills.length
                          ? optKeys.map((k) => (
                              <div key={k} className="rounded-xl border border-ink-950/8 bg-white/60 px-3.5 py-3">
                                <div className="skeleton mb-2 h-3 w-28 rounded-full" />
                                <div className="skeleton mb-1.5 h-2.5 w-full rounded-full" />
                                <div className="skeleton h-2.5 w-4/5 rounded-full" />
                              </div>
                            ))
                          : optKeys.map((k) => {
                              const isAns = (q.answer || []).includes(k);
                              const isPick = picked.includes(k);
                              const mine = isPick && !isAns;
                              return (
                                <div
                                  key={k}
                                  className={`rounded-xl border px-3.5 py-3 transition-colors ${
                                    isAns
                                      ? "border-apple-green/32 bg-apple-green/[0.055]"
                                      : mine
                                      ? "border-apple-red/32 bg-apple-red/[0.05]"
                                      : "border-ink-950/8 bg-ink-950/[0.02]"
                                  }`}
                                >
                                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                    <span
                                      className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                                        isAns
                                          ? "bg-apple-green/22 text-apple-green"
                                          : mine
                                          ? "bg-apple-red/20 text-apple-red"
                                          : "bg-ink-950/10 text-ink-900/66"
                                      }`}
                                    >
                                      {k}
                                    </span>
                                    <span className="text-[12.5px] font-semibold text-ink-900/88">
                                      {q.options[k]}
                                    </span>
                                    {isAns && (
                                      <span className="ml-auto text-[10.5px] font-semibold text-apple-green">
                                        正确答案
                                      </span>
                                    )}
                                    {mine && (
                                      <span className="ml-auto rounded-full bg-apple-red/12 px-2 py-0.5 text-[10.5px] font-semibold text-apple-red">
                                        你的错选
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[12.5px] leading-[1.78] text-ink-900/66">
                                    {matrix[k] || "点右上角「AI 重新精析」生成这个选项的医学剖析。"}
                                  </p>
                                </div>
                              );
                            })}
                      </div>
                    </div>
                  )}

                  {tab === "compare" && (
                    <div className="max-h-[46vh] overflow-y-auto">
                      <div className="grid grid-cols-2 gap-2.5">
                        {optKeys.map((k) => {
                          const isAns = (q.answer || []).includes(k);
                          return (
                            <div
                              key={k}
                              className={`rounded-xl border p-3 ${
                                isAns
                                  ? "border-apple-green/30 bg-apple-green/[0.06]"
                                  : "border-ink-950/8 bg-ink-950/[0.02]"
                              }`}
                            >
                              <div className="mb-1.5 flex items-center gap-1.5">
                                <span
                                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
                                    isAns ? "bg-apple-green/22 text-apple-green" : "bg-ink-950/10 text-ink-900/66"
                                  }`}
                                >
                                  {k}
                                </span>
                                <span className="truncate text-[12px] font-medium text-ink-900/82">
                                  {q.options[k]}
                                </span>
                              </div>
                              <p className="text-[11.5px] leading-[1.7] text-ink-900/58">
                                {matrix[k] || "—"}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                      <p className="mt-3 text-[11px] text-ink-900/36">
                        绿色边框 = 正确答案；对照看每个名词的差异，专治「长得像」的干扰项。
                      </p>
                    </div>
                  )}
                </div>

                {images.length > 0 && (
                  <div className="shrink-0">
                    <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
                      {images.map((src) => (
                        <button
                          key={src}
                          onClick={() => setLightbox(src)}
                          className="group relative h-[96px] w-[132px] shrink-0 overflow-hidden rounded-xl border border-ink-950/10 lg:h-[92px] lg:w-full"
                        >
                          <img
                            src={mediaUrl(src)}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                          <span className="absolute inset-0 flex items-center justify-center bg-ink-950/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                            <ZoomIn className="h-4 w-4" />
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ---- 错题印记写回（只有连了本地 Obsidian 库才有意义） */}
        {kb?.mode === "obsidian" ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-950/8 pt-3.5">
            <span className="text-[11.5px] text-ink-900/44">
              {errCount >= 3
                ? `这道题已经错了 ${errCount} 次`
                : `错满 3 次可注入印记（当前 ${errCount} 次）`}
            </span>
            <button
              disabled={errCount < 3 || writing || markState?.ok}
              onClick={inject}
              className={`btn px-3 py-1.5 text-[12px] ${
                errCount >= 3 && !markState?.ok
                  ? "border border-apple-red/35 bg-apple-red/10 text-apple-red hover:bg-apple-red/16"
                  : "border border-ink-950/10 bg-ink-950/[0.03] text-ink-900/40"
              }`}
            >
              {writing ? <Loader2 className="h-3 w-3 animate-spin" /> : <PenLine className="h-3 w-3" />}
              {markState?.ok ? "已写入笔记" : "注入错题印记到 Obsidian"}
            </button>
            {markState && !markState.ok && (
              <span className="text-[11px] text-apple-red">{markState.msg}</span>
            )}
            {markState?.ok && (
              <span className="text-[11px] text-ink-900/44">
                {markState.action === "updated" ? "已更新次数" : "已插入 Callout 块"}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-950/8 pt-3.5">
            <span className="text-[11.5px] text-ink-900/40">
              当前是「内置静态解析」：笔记正文与图谱随题库打包，不需要本地 Obsidian。
            </span>
            <button
              onClick={() => { setSettingsSection("kb"); setSettingsOpen(true); }}
              className="btn-ghost px-2.5 py-1 text-[11.5px]"
            >
              连接我的 Obsidian 库
            </button>
          </div>
        )}
      </div>

      {/* ---- 灯箱 */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-8 backdrop-blur-md"
          >
            <motion.img
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 28 }}
              src={mediaUrl(lightbox)}
              alt=""
              className="max-h-full max-w-full rounded-2xl bg-white shadow-2xl"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
