import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight, ChevronRight, Flame, Layers, TrendingUp, Zap,
} from "lucide-react";
import { useStore } from "../store";
import { Ring, Heat, Bar } from "../components/Bits";
import Chart, { roseOption, rankOption } from "../components/Chart";
import { WrongOverviewModal, CramOverviewModal } from "../components/OverviewModals";
import { api } from "../api";

export default function Home({ go }) {
  const { stats, progress, cramItems, list, flash } = useStore();
  const [kw, setKw] = useState([]);
  const [loadingCram, setLoadingCram] = useState(false);
  const [cramLimit, setCramLimit] = useState("50"); // "20" | "50" | "100" | "all"
  const [wrongOpen, setWrongOpen] = useState(false);
  const [cramOpen, setCramOpen] = useState(false);

  // 失分概念 Top：从进度里取出错过的题，按关键词累计错误次数
  useEffect(() => {
    const byId = new Map(list.map((q) => [q.id, q]));
    const acc = new Map();
    for (const [id, r] of Object.entries(progress.questions || {})) {
      const err = r.error_count || 0;
      if (!err) continue;
      const q = byId.get(id);
      if (!q) continue;
      for (const k of q.keywords || []) {
        acc.set(k, (acc.get(k) || 0) + err);
      }
    }
    setKw(
      [...acc.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, value]) => ({ name, value }))
    );
  }, [progress.questions, list]);

  // 章节错题分布（玫瑰图）
  const chapterRose = useMemo(() => {
    const byId = new Map(list.map((q) => [q.id, q]));
    const acc = new Map();
    for (const [id, r] of Object.entries(progress.questions || {})) {
      const err = r.error_count || 0;
      if (!err) continue;
      const q = byId.get(id);
      if (!q) continue;
      acc.set(q.chapter, (acc.get(q.chapter) || 0) + err);
    }
    return [...acc.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [progress.questions, list]);

  // 章节正确率（有作答记录的章节）
  const chapterAcc = useMemo(() => {
    const byId = new Map(list.map((q) => [q.id, q]));
    const acc = new Map();
    for (const [id, r] of Object.entries(progress.questions || {})) {
      if (!r.seen) continue;
      const q = byId.get(id);
      if (!q) continue;
      const cur = acc.get(q.chapter) || { seen: 0, correct: 0 };
      cur.seen += r.seen;
      cur.correct += r.correct || 0;
      acc.set(q.chapter, cur);
    }
    return [...acc.entries()]
      .map(([name, v]) => ({ name, ...v, acc: v.correct / Math.max(1, v.seen) }))
      .sort((a, b) => a.acc - b.acc)
      .slice(0, 6);
  }, [progress.questions, list]);

  const crams = cramItems.slice(0, 3);
  const todayK = new Date().toISOString().slice(0, 10);
  const todayRec = progress.daily?.[todayK] || { n: 0, ok: 0 };
  const today = todayRec.n || 0;
  const todayOk = todayRec.ok || 0;

  const cramTargetCount = useMemo(() => {
    if (!cramItems.length) return 0;
    if (cramLimit === "all") return cramItems.length;
    return Math.min(Number(cramLimit) || 50, cramItems.length);
  }, [cramItems.length, cramLimit]);

  async function startCram() {
    setLoadingCram(true);
    try {
      const wantN = cramLimit === "all" ? 0 : Number(cramLimit) || 50;
      const r = await api.cram(wantN);
      if (!r.items.length) {
        flash("急救池是空的，先去练一组吧");
        go("practice");
        return;
      }
      sessionStorage.setItem("cram_ids", JSON.stringify(r.items.map((x) => x.id)));
      go("practice");
    } finally {
      setLoadingCram(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ---------------- Hero */}
      <section className="flex flex-col gap-6 pb-2 pt-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="label mb-2">人体结构学 · 系统解剖学与组织胚胎学</p>
          <h1 className="max-w-2xl text-[34px] font-semibold leading-[1.22] tracking-[-0.03em] md:text-[46px]">
            在某个地方，有<span className="bg-gradient-to-r from-apple-blue via-apple-teal to-apple-green bg-clip-text text-transparent">不可思议</span>的事情
            <br className="hidden md:block" />
            正等待着被发现。
          </h1>
          <p className="mt-2 text-[13px] font-normal text-ink-900/40 md:text-[14.5px]">
            —— 卡尔·萨根
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button className="btn-primary px-5 py-2.5" onClick={() => go("practice")}>
            开始练习
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
          <button className="btn-ghost px-5 py-2.5" onClick={() => go("analysis")}>
            看分析
          </button>
        </div>
      </section>

      {/* ---------------- Bento */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-12">
        {/* 主卡：覆盖率环 + 刷题进度 */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.02 }}
          className="card col-span-2 flex flex-col overflow-hidden md:col-span-5"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="label">刷题进度</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-900/52">
                已覆盖 <b className="text-ink-900/85">{stats.seen}</b> / {stats.total} 题
                <br />
                正确率 <b className="text-ink-900/85">{(stats.accuracy * 100).toFixed(0)}%</b>
                {" · "}已掌握 <b className="text-apple-green">{stats.mastered}</b>
              </p>
            </div>
            <Ring value={stats.coverage} size={132} stroke={10} label="覆盖率" />
          </div>

          <div className="mt-5 rounded-xl border border-ink-950/8 bg-ink-950/[0.02] px-3.5 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[11.5px] text-ink-900/52">今日作答</span>
              <span className="tabular-nums text-[12px] text-ink-900/60">
                <b className="text-[16px] text-ink-900/90">{today}</b> 题
                {todayOk ? ` · 正确 ${todayOk}` : ""}
                <span className="text-ink-900/35"> / 目标 30</span>
              </span>
            </div>
            <div className="mt-2">
              <Bar value={Math.min(1, today / 30)} tone={today >= 30 ? "green" : "blue"} height={6} />
            </div>
          </div>

          <div className="mt-auto pt-4">
            <div className="grid grid-cols-3 gap-2 border-t border-ink-950/8 pt-4">
              <MiniNum label="累计作答" value={stats.attempts} />
              <MiniNum
                label="错题存量"
                value={stats.wrong}
                tone="red"
                onClick={() => setWrongOpen(true)}
                title="点击查看错题存量概览"
              />
              <MiniNum label="收藏" value={stats.starred} tone="yellow" />
            </div>
          </div>
        </motion.div>

        {/* 突击队列 */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
          className="card col-span-2 flex flex-col md:col-span-4"
        >
          <div
            onClick={() => setCramOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setCramOpen(true);
              }
            }}
            className="group -mx-2 -mt-1 flex cursor-pointer items-center justify-between rounded-xl px-2 py-1 transition-colors hover:bg-ink-950/[0.03]"
            title="点击展开突击队列完整概览"
          >
            <p className="label flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-apple-yellow" />
              考前突击队列
              <ChevronRight className="h-3 w-3 text-ink-900/32 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-900/70" />
            </p>
            <span className="chip border-apple-yellow/25 bg-apple-yellow/10 text-apple-yellow/90 tabular-nums transition-colors group-hover:border-apple-yellow/45">
              {cramItems.length}
              <span className="ml-0.5 text-[10px] opacity-75">查看全部</span>
            </span>
          </div>

          <p
            onClick={() => setCramOpen(true)}
            className="mt-2 cursor-pointer text-[12.5px] leading-relaxed text-ink-900/48"
          >
            权重 = 错误次数 × 2 − 连对 + 收藏加成。连对 3 次自动毕业。
          </p>

          <div className="mt-3 space-y-1.5">
            {crams.length === 0 && (
              <p className="rounded-xl bg-ink-950/[0.03] px-3 py-4 text-center text-[12px] text-ink-900/40">
                急救池是空的 —— 目前没有需要抢救的题
              </p>
            )}
            {crams.map((c) => (
              <button
                key={c.id}
                onClick={() => go("practice", c.id)}
                className="group flex w-full items-center gap-2.5 rounded-xl border border-ink-950/8 bg-ink-950/[0.025] px-3 py-2 text-left transition-colors hover:border-ink-950/18 hover:bg-ink-950/[0.06]"
              >
                <span className="tabular-nums text-[11px] font-semibold text-apple-red/80">
                  P{c.priority}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-900/70 group-hover:text-ink-900/90">
                  {c.stem}
                </span>
                <span className="shrink-0 text-[10.5px] text-ink-900/36">
                  错 {c.error_count}
                </span>
              </button>
            ))}
            {cramItems.length > 3 && (
              <button
                onClick={() => setCramOpen(true)}
                className="flex w-full items-center justify-center gap-1 rounded-lg py-1 text-[11.5px] text-ink-900/46 transition-colors hover:bg-ink-950/[0.035] hover:text-ink-900/80"
              >
                展开全部 {cramItems.length} 道待抢救题目
                <ChevronRight className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="mt-auto pt-3">
            <div className="mb-2 flex items-center justify-between gap-1.5">
              <span className="text-[11px] text-ink-900/42">单次抢救：</span>
              <div className="flex rounded-full border border-ink-950/10 bg-ink-950/[0.035] p-0.5">
                {[
                  ["20", "20"],
                  ["50", "50"],
                  ["100", "100"],
                  ["all", "全部"],
                ].map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setCramLimit(k)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
                      cramLimit === k
                        ? "bg-white text-ink-900 shadow-sm"
                        : "text-ink-900/48 hover:text-ink-900/78"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={startCram}
              disabled={loadingCram}
              className="btn-primary w-full py-2.5 disabled:opacity-50"
            >
              <Flame className="h-3.5 w-3.5" />
              抢救 {cramTargetCount || cramItems.length} 个死角
            </button>
          </div>
        </motion.div>

        {/* 热力 + 各篇正确率 */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="card col-span-2 md:col-span-3"
        >
          <p className="label">近 14 天</p>
          <div className="mt-3">
            <Heat daily={progress.daily || {}} />
          </div>
          <div className="mt-4 space-y-2 border-t border-ink-950/8 pt-3.5">
            <p className="label">章节正确率（最低 6 项）</p>
            {chapterAcc.length === 0 && (
              <p className="py-2 text-[12px] text-ink-900/40">还没有作答记录</p>
            )}
            {chapterAcc.map((c) => (
              <div key={c.name} className="space-y-1">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="truncate text-ink-900/62">{c.name}</span>
                  <span className="tabular-nums text-ink-900/44">
                    {(c.acc * 100).toFixed(0)}%
                  </span>
                </div>
                <Bar
                  value={c.acc}
                  tone={c.acc < 0.6 ? "red" : c.acc < 0.8 ? "yellow" : "green"}
                  height={4}
                />
              </div>
            ))}
          </div>
        </motion.div>

        {/* 章节错题玫瑰图 */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          className="card col-span-2 md:col-span-5"
        >
          <div className="flex items-center justify-between">
            <p className="label flex items-center gap-1.5">
              <Layers className="h-3 w-3" />
              错题章节分布
            </p>
            <span className="text-[11px] text-ink-900/36">按下错次数</span>
          </div>
          {chapterRose.length ? (
            <Chart option={roseOption(chapterRose)} height={244} />
          ) : (
            <Empty h={244} text="还没有错题 —— 保持住" />
          )}
        </motion.div>

        {/* 失分概念排行 */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          className="card col-span-2 md:col-span-7"
        >
          <div className="flex items-center justify-between">
            <p className="label flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" />
              高频失分概念 Top 10
            </p>
            <span className="text-[11px] text-ink-900/36">点击直接练这些题</span>
          </div>
          {kw.length ? (
            <Chart option={rankOption(kw)} height={244} />
          ) : (
            <Empty h={244} text="答错的题会自动统计到这里" />
          )}
        </motion.div>
      </div>

      {/* 弹窗：错题存量概览 / 突击队列完整概览 */}
      <WrongOverviewModal open={wrongOpen} onClose={() => setWrongOpen(false)} go={go} />
      <CramOverviewModal
        open={cramOpen}
        onClose={() => setCramOpen(false)}
        go={go}
        defaultLimit={cramLimit}
      />
    </div>
  );
}

function MiniNum({ label, value, tone = "white", onClick, title }) {
  const tones = { white: "text-ink-900", red: "text-apple-red", yellow: "text-apple-yellow" };
  if (typeof onClick === "function") {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="group -mx-2 -my-1.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-apple-red/[0.06]"
      >
        <p className="flex items-center gap-0.5 text-[10.5px] text-ink-900/40 group-hover:text-apple-red/80">
          {label}
          <ChevronRight className="h-2.5 w-2.5 transition-transform group-hover:translate-x-0.5" />
        </p>
        <p className={`mt-0.5 text-[17px] font-semibold tabular-nums ${tones[tone]}`}>
          {value}
        </p>
      </button>
    );
  }
  return (
    <div>
      <p className="text-[10.5px] text-ink-900/40">{label}</p>
      <p className={`mt-0.5 text-[17px] font-semibold tabular-nums ${tones[tone]}`}>
        {value}
      </p>
    </div>
  );
}

function Empty({ h, text }) {
  return (
    <div
      className="flex items-center justify-center rounded-xl bg-ink-950/[0.02] text-[12.5px] text-ink-900/36"
      style={{ height: h }}
    >
      {text}
    </div>
  );
}
