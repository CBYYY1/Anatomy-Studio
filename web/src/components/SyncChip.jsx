import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Check, CloudDownload, Loader2, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";

/**
 * 导航栏「云端同步」胶囊。
 *
 * 三种形态：
 *   1. 平静态    🔄 同步题库          —— 远端没有新内容
 *   2. 有更新    🟢 有新章节笔记可同步 —— 远端 questions.json 的 commit 比本地新
 *   3. 同步中    ⟳ 正在同步 62%       —— 进度条 + 阶段文案
 *
 * 点击只做一件事：把仓库里最新的 data/questions.json 与缺失的配图拉下来。
 * 后端保证不碰 user_progress.json（错题记录）与 user_config.json（API Key）。
 */
export default function SyncChip({ onDone }) {
  const { flash, refreshAll } = useStore();
  const [meta, setMeta] = useState(null);
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [sync, setSync] = useState(null);       // {phase, done, total, message}
  const [open, setOpen] = useState(false);      // 气泡
  const [hover, setHover] = useState(false);
  const pollRef = useRef(null);
  const ranRef = useRef(false);

  const running = sync?.running || checking;

  const loadMeta = useCallback(async () => {
    try {
      const m = await api.updaterMeta();
      setMeta(m);
      return m;
    } catch {
      return null;
    }
  }, []);

  const check = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const r = await api.updaterCheck(fresh);
      setInfo(r);
      return r;
    } catch (e) {
      setInfo({ ok: false, detail: String(e.message || e) });
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  // 启动时静默检查一次（是否静默由设置里的 auto_check 决定）
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      const m = await loadMeta();
      if (m && m.auto_check === false) return;
      await check(false);
    })();
  }, [loadMeta, check]);

  // 同步时轮询进度，直到后端说 running=false
  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.updaterStatus();
        setSync(s);
      } catch { /* 忽略：下一轮再试 */ }
    }, 400);
    return () => clearInterval(pollRef.current);
  }, [running]);

  const doSync = async () => {
    setOpen(false);
    setSync({ running: true, phase: "fetch", done: 0, total: 0, message: "正在连接 GitHub…" });
    try {
      const r = await api.syncBank();
      setSync({ running: false, phase: r.ok ? "done" : "error", message: r.detail || "" });
      if (r.ok) {
        flash(r.detail || "已同步最新题库与笔记（保留个人刷题记录）");
        await refreshAll?.();
        await check(true);
        onDone?.(r);
      } else {
        flash(r.detail || "同步失败", "bad");
      }
    } catch (e) {
      setSync({ running: false, phase: "error", message: String(e.message || e) });
      flash(`同步失败：${e.message || e}`, "bad");
    } finally {
      loadMeta();
      setTimeout(() => setSync(null), 2600);
    }
  };

  const hasBank = !!info?.has_new_question_bank;
  const hasApp = !!info?.has_new_app_release;
  const pct = sync?.total ? Math.min(100, Math.round((sync.done / sync.total) * 100)) : null;
  const label = running ? "正在同步" : hasBank ? "有新章节笔记可同步" : "同步题库";

  // 悬浮气泡内容：最新题库版本 + 变更说明 / 出错原因 / 版本提示
  const remoteBank = info?.remote_manifest?.bank_version || "";
  const tip = (() => {
    if (running) return sync?.message || "正在从仓库拉取最新题库与配图…";
    if (!info) return "点一下检查云端有没有新内容";
    if (info.ok === false) return info.detail || "连不上 GitHub，稍后再试";
    const lines = [];
    if (remoteBank) lines.push(`题库版本：${remoteBank}`);
    const change = info.remote_manifest?.bank_changelog || info.commit?.message;
    if (change) lines.push(`更新内容：${change}`);
    if (!hasBank && info.ok) lines.push("题库已是最新，没有需要同步的内容");
    return lines.join("\n");
  })();

  return (
    <div className="relative">
      <button
        onClick={() => (hasBank || hasApp ? setOpen((v) => !v) : doSync())}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={running}
        className={`chip relative overflow-hidden transition-colors ${
          hasBank
            ? "border-apple-green/35 bg-apple-green/10 text-apple-green"
            : "hover:border-ink-950/22 hover:bg-ink-950/[0.06]"
        }`}
        title={tip}
      >
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : hasBank ? (
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-apple-green opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-apple-green" />
          </span>
        ) : (
          <CloudDownload className="h-3 w-3" />
        )}
        <span className="tabular-nums">{label}</span>
        {running && pct !== null && <span className="tabular-nums opacity-62">{pct}%</span>}
        {running && (
          <span
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-apple-blue/70 transition-[width] duration-300"
            style={{ width: `${sync?.phase === "media" && pct !== null ? pct : 12}%` }}
          />
        )}
      </button>

      {/* 悬停提示（无更新时轻量显示 commit 说明；同步结束时让位给完成卡，否则两块会叠在一起） */}
      <AnimatePresence>
        {hover && !open && tip && !(sync && !sync.running) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-50 w-[268px] whitespace-pre-line rounded-xl border border-ink-950/10 bg-white/95 px-3 py-2 text-[11.5px] leading-relaxed text-ink-900/72 shadow-bento backdrop-blur-xl"
          >
            {tip}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 点击后的确认气泡：有更新才展开 */}
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              className="absolute right-0 top-[calc(100%+10px)] z-50 w-[330px] rounded-2xl border border-ink-950/10 bg-white p-4 shadow-bento"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold">云端有新内容</p>
                  <p className="mt-1 break-words text-[11.5px] leading-relaxed text-ink-900/58">
                    {info?.remote_manifest?.bank_changelog
                      || info?.commit?.message
                      || "仓库更新了题库与笔记映射"}
                  </p>
                  {remoteBank ? (
                    <p className="mt-1 text-[11px] text-ink-900/38">
                      题库版本 {remoteBank}
                    </p>
                  ) : info?.commit?.date ? (
                    <p className="mt-1 text-[11px] text-ink-900/38">
                      提交于 {new Date(info.commit.date * 1000).toLocaleString("zh-CN")}
                    </p>
                  ) : null}
                </div>
                <button onClick={() => setOpen(false)} className="btn-ghost px-1.5 py-1">
                  <X className="h-3 w-3" />
                </button>
              </div>

              <div className="mt-3 space-y-1.5">
                <button onClick={doSync} className="btn-primary w-full justify-center py-2 text-[12.5px]">
                  <CloudDownload className="h-3.5 w-3.5" />
                  同步最新题库与笔记
                </button>
                {hasApp && info?.release?.url && (
                  <a
                    href={info.release.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost w-full justify-center py-2 text-[12px]"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    客户端有新版 {info.release.tag}，去 Releases 下载
                  </a>
                )}
                <p className="pt-0.5 text-center text-[10.5px] text-ink-900/38">
                  只更新题库、笔记与配图；错题记录和个人设置不受影响
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* 同步完成的轻提示（独立于全局 toast，带 ✓ 图标） */}
      <AnimatePresence>
        {sync && !sync.running && sync.phase === "done" && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute right-0 top-[calc(100%+8px)] z-50 flex w-[300px] items-start gap-2 rounded-xl border border-apple-green/30 bg-apple-green/10 px-3 py-2 text-[11.5px] text-apple-green"
          >
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{sync.message || "已同步最新题库与笔记（保留个人刷题记录）"}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
