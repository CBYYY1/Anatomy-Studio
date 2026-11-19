import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity, Award, BarChart3, Crosshair, Flame, TrendingDown, TrendingUp,
} from "lucide-react";
import { useStore } from "../store";
import { Ring, Stat, Heat, Bar } from "../components/Bits";
import Chart, { roseOption, rankOption } from "../components/Chart";
import { WrongOverviewModal } from "../components/OverviewModals";

export default function Analysis({ go }) {
  const { list, progress, stats, meta } = useStore();
  const [wrongOpen, setWrongOpen] = useState(false);

  const byId = useMemo(() => new Map(list.map((q) => [q.id, q])), [list]);

  // 每个章节：seen / correct / errors / 总题量
  const chapters = useMemo(() => {
    const acc = new Map();
    for (const q of list) {
      const cur = acc.get(q.chapter) || { name: q.chapter, total: 0, seen: 0, correct: 0, err: 0 };
      cur.total += 1;
      const r = progress.questions[q.id];
      if (r) {
        cur.seen += r.seen ? 1 : 0;
        cur.correct += r.correct || 0;
        cur.err += r.error_count || 0;
      }
      acc.set(q.chapter, cur);
    }
    return [...acc.values()]
      .map((c) => ({
        ...c,
        coverage: c.total ? c.seen / c.total : 0,
        acc: c.seen ? c.correct / Math.max(1, c.seen) : 0,
        errRate: c.seen ? Math.min(1, c.err / Math.max(1, c.seen)) : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [list, progress.questions]);

  const errTop = useMemo(
    () => chapters.filter((c) => c.err > 0).sort((a, b) => b.err - a.err).slice(0, 12)
      .map((c) => ({ name: c.name, value: c.err })),
    [chapters]
  );

  const roseData = useMemo(
    () => chapters.filter((c) => c.err > 0).sort((a, b) => b.err - a.err)
      .slice(0, 10).map((c) => ({ name: c.name, value: c.err })),
    [chapters]
  );

  const kwTop = useMemo(() => {
    const acc = new Map();
    for (const [id, r] of Object.entries(progress.questions || {})) {
      const err = r.error_count || 0;
      if (!err) continue;
      const q = byId.get(id);
      if (!q) continue;
      for (const k of q.keywords || []) acc.set(k, (acc.get(k) || 0) + err);
    }
    return [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, value]) => ({ name, value }));
  }, [progress.questions, byId]);

  const weakest = chapters
    .filter((c) => c.seen >= 3)
    .sort((a, b) => a.acc - b.acc)
    .slice(0, 5);

  const trend = useMemo(() => {
    const days = [];
    for (let i = 20; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const rec = progress.daily?.[key] || { n: 0, ok: 0 };
      days.push({ key, ...rec, rate: rec.n ? rec.ok / rec.n : null });
    }
    return days;
  }, [progress.daily]);

  const activeDays = trend.filter((d) => d.n > 0).length;

  return (
    <div className="space-y-4">
      <section className="pb-1 pt-2">
        <p className="label mb-1.5">薄弱点分析</p>
        <h1 className="max-w-3xl text-[30px] font-semibold leading-[1.24] tracking-[-0.02em] md:text-[38px]">
          经验不过是我们给<span className="text-apple-red">错误</span>取的名字。
        </h1>
        <p className="mt-2 text-[13px] font-normal text-ink-900/40 md:text-[14.5px]">
          —— 奥斯卡·王尔德《温夫人的扇子》
        </p>
      </section>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-12">
        <Stat label="覆盖率" value={`${(stats.coverage * 100).toFixed(0)}`} suffix="%" tone="blue"
          hint={`${stats.seen} / ${stats.total} 题`} icon={Crosshair}
          className="col-span-1 md:col-span-3" />
        <Stat label="全局正确率" value={`${(stats.accuracy * 100).toFixed(0)}`} suffix="%"
          tone={stats.accuracy > 0.75 ? "green" : stats.accuracy > 0.55 ? "yellow" : "red"}
          hint={`累计作答 ${stats.attempts} 次`} icon={Activity}
          className="col-span-1 md:col-span-3" />
        <Stat
          label="错题存量"
          value={stats.wrong}
          tone="red"
          hint="至少错过一次 · 点击展开概览"
          icon={TrendingDown}
          onClick={() => setWrongOpen(true)}
          className="col-span-1 md:col-span-3"
        />
        <Stat label="已掌握" value={stats.mastered} tone="green" hint="连对 ≥ 3 次" icon={Award}
          className="col-span-1 md:col-span-3" />

        <motion.div className="card col-span-2 flex flex-col md:col-span-4">
          <p className="label">覆盖与作答</p>
          <div className="mt-3 flex flex-1 items-center justify-around">
            <Ring value={stats.coverage} size={104} stroke={8} label="覆盖" tone="blue" />
            <Ring value={stats.accuracy} size={104} stroke={8} label="正确" tone="green" />
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-ink-950/[0.03] px-3 py-2 text-[11.5px]">
            <span className="text-ink-900/48">还没碰过的题</span>
            <span className="tabular-nums text-ink-900/80">
              {Math.max(0, stats.total - stats.seen)} 道
            </span>
          </div>
        </motion.div>

        <motion.div className="card col-span-2 md:col-span-4">
          <p className="label mb-3">近 14 天做题热力</p>
          <Heat daily={progress.daily || {}} days={14} />
        </motion.div>

        <motion.div className="card col-span-2 md:col-span-4">
          <p className="label">活跃天数</p>
          <p className="stat-num mt-2">
            {activeDays}
            <span className="ml-1 text-[13px] text-ink-900/44">/ 21 天</span>
          </p>
          <div className="mt-3 space-y-1.5">
            {trend.slice(-9).map((d) => (
              <div key={d.key} className="flex items-center gap-2">
                <span className="w-11 shrink-0 font-mono text-[10px] text-ink-900/36">
                  {d.key.slice(5)}
                </span>
                <div className="flex-1">
                  <Bar value={d.rate ?? 0} tone={d.rate === null ? "blue" : d.rate > 0.75 ? "green" : d.rate > 0.5 ? "yellow" : "red"} height={4} />
                </div>
                <span className="w-7 shrink-0 text-right font-mono text-[10px] text-ink-900/36 tabular-nums">
                  {d.n || "-"}
                </span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* 玫瑰图 */}
        <motion.div className="card col-span-2 md:col-span-5">
          <div className="flex items-center justify-between">
            <p className="label flex items-center gap-1.5">
              <BarChart3 className="h-3 w-3" />
              错题章节分布
            </p>
          </div>
          {roseData.length ? (
            <Chart option={roseOption(roseData)} height={280} />
          ) : (
            <div className="flex h-[280px] items-center justify-center text-[12.5px] text-ink-900/36">
              还没有错题
            </div>
          )}
        </motion.div>

        {/* 失分概念 */}
        <motion.div className="card col-span-2 md:col-span-7">
          <div className="flex items-center justify-between">
            <p className="label flex items-center gap-1.5">
              <Flame className="h-3 w-3 text-apple-orange" />
              高频失分概念
            </p>
            <span className="text-[11px] text-ink-900/36">累计错误次数</span>
          </div>
          {kwTop.length ? (
            <Chart option={rankOption(kwTop)} height={280} />
          ) : (
            <div className="flex h-[280px] items-center justify-center text-[12.5px] text-ink-900/36">
              答错的题会自动出现在这里
            </div>
          )}
        </motion.div>

        {/* 章节明细 */}
        <motion.div className="card col-span-2 md:col-span-7">
          <p className="label mb-3 flex items-center gap-1.5">
            <TrendingUp className="h-3 w-3" />
            章节正确率与覆盖率
          </p>
          <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
            {chapters.map((c) => (
              <button
                key={c.name}
                onClick={() => go("practice")}
                className="group w-full text-left"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12.5px] text-ink-900/70 group-hover:text-ink-900">
                    {c.name}
                    <span className="ml-1.5 text-[10.5px] text-ink-900/36">{c.total} 题</span>
                  </span>
                  <span className="tabular-nums text-[11.5px] text-ink-900/44">
                    {c.seen ? `${(c.acc * 100).toFixed(0)}%` : "—"}
                    <span className="ml-2 text-ink-900/32">
                      覆盖 {(c.coverage * 100).toFixed(0)}%
                    </span>
                  </span>
                </div>
                <div className="relative flex gap-1">
                  <div className="flex-1">
                    <Bar value={c.acc} tone={c.acc < 0.6 ? "red" : c.acc < 0.8 ? "yellow" : "green"} height={5} />
                  </div>
                  <div className="w-[22%]">
                    <Bar value={c.coverage} tone="blue" height={5} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </motion.div>

        {/* 最弱章节 */}
        <motion.div className="card col-span-2 flex flex-col md:col-span-5">
          <p className="label mb-3">最该补的 5 个章节</p>
          {weakest.length === 0 && (
            <p className="py-8 text-center text-[12.5px] text-ink-900/40">
              每个章节至少做 3 题后才会进榜
            </p>
          )}
          <div className="space-y-2.5">
            {weakest.map((c, idx) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-950/[0.07] text-[11px] font-bold text-ink-900/58">
                  {idx + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-900/74">
                  {c.name}
                </span>
                <span className="shrink-0 tabular-nums text-[12px] text-apple-red/85">
                  {(c.acc * 100).toFixed(0)}%
                </span>
                <button
                  onClick={() => {
                    sessionStorage.setItem("cram_hint", c.name);
                    go("practice");
                  }}
                  className="btn-ghost shrink-0 px-2.5 py-1 text-[11px]"
                >
                  去练
                </button>
              </div>
            ))}
          </div>

          <div className="mt-auto border-t border-ink-950/8 pt-4">
            <p className="label mb-2">题库构成</p>
            <div className="grid grid-cols-2 gap-2 text-[11.5px]">
              <Row k="单选题" v={`${meta?.single ?? 0}`} />
              <Row k="多选题" v={`${meta?.multiple ?? 0}`} />
              <Row k="带图谱" v={`${meta?.stats?.with_images ?? 0}`} />
              <Row k="知识点" v={`${meta?.stats?.knowledge_terms ?? 0}`} />
            </div>
          </div>
        </motion.div>
      </div>

      <WrongOverviewModal open={wrongOpen} onClose={() => setWrongOpen(false)} go={go} />
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-ink-950/[0.03] px-2.5 py-1.5">
      <span className="text-ink-900/48">{k}</span>
      <span className="tabular-nums text-ink-900/74">{v}</span>
    </div>
  );
}
