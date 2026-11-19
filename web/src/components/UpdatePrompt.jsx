import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight, Check, CloudDownload, ExternalLink, Loader2, Sparkles, X, Zap,
} from "lucide-react";
import { api } from "../api";

/**
 * 应用内主动更新提示（Auto-Update Notification）。
 *
 * 与导航栏那个「同步胶囊」分工不同：
 *   - 胶囊：随时可用的小入口，平时是「同步题库」，有更新时变绿点。
 *   - 这个弹窗：启动时检测到**题库有新版本**或**客户端有新版本**时主动出现，
 *     把更新内容（bank_changelog / app_release_notes）摆在用户面前，
 *     并提供「⚡ 一键自动更新并重启 / 立即同步题库 / 手动前往 GitHub 下载 / 稍后 / 这个版本不再提示」。
 */

const SEEN_KEY = "anatomy.update.seen.v1";

function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeSeen(patch) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), ...patch }));
  } catch { /* 隐私模式忽略 */ }
}

export default function UpdatePrompt() {
  const [info, setInfo] = useState(null);   // check 的完整返回
  const [meta, setMeta] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [appUpd, setAppUpd] = useState(null); // {running, phase, percent, message, restarting}
  const pollRef = useRef(null);
  const reconnectRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await api.updaterMeta();
        if (!alive) return;
        setMeta(m);
        if (m?.auto_check === false || m?.notify === false) return;

        const r = await api.updaterCheck(false);
        if (!alive || !r?.ok) return;
        setInfo(r);

        const remoteBank = r.remote_manifest?.bank_version || "";
        const remoteApp = r.remote_manifest?.app_version || "";
        if (!r.has_new_question_bank && !r.has_new_app_release) return;

        // 同一版只提醒一次
        const seen = readSeen();
        const bankSeen = remoteBank && seen.bank_version === remoteBank;
        const appSeen = remoteApp && seen.app_version === remoteApp;
        if (bankSeen && (appSeen || !r.has_new_app_release)) return;
        if (appSeen && !r.has_new_question_bank) return;

        setOpen(true);
      } catch { /* 检测失败就安静待着，不打扰刷题 */ }
    })();
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (reconnectRef.current) clearInterval(reconnectRef.current);
    };
  }, []);

  const remoteBank = info?.remote_manifest?.bank_version || "";
  const remoteApp = info?.remote_manifest?.app_version || "";
  const hasBank = !!info?.has_new_question_bank;
  const hasApp = !!(info?.has_new_app_release || info?.has_app_update);
  const changelog = info?.remote_manifest?.bank_changelog
    || info?.commit?.message || "更新章节笔记映射与靶向解析缓存";
  const releaseNotes = info?.remote_manifest?.app_release_notes || "";
  const releaseUrl = appUpd?.manual_url
    || info?.remote_manifest?.release_url
    || meta?.releases_url
    || (info?.repo ? `https://github.com/${info.repo}/releases` : "");
  const stats = info?.remote_manifest?.stats || {};

  const dismiss = (remember) => {
    if (appUpd?.running || appUpd?.restarting) return;
    if (remember) {
      const patch = {};
      if (remoteBank) patch.bank_version = remoteBank;
      if (remoteApp) patch.app_version = remoteApp;
      writeSeen(patch);
    }
    setOpen(false);
  };

  const waitAndReload = () => {
    if (reconnectRef.current) clearInterval(reconnectRef.current);
    const t0 = Date.now();
    setTimeout(() => {
      reconnectRef.current = setInterval(async () => {
        try {
          const m = await api.updaterMeta();
          if (m?.app_version) {
            clearInterval(reconnectRef.current);
            window.location.reload();
          }
        } catch {
          if (Date.now() - t0 > 45000) {
            clearInterval(reconnectRef.current);
          }
        }
      }, 1000);
    }, 1800);
  };

  const doAppUpdate = async () => {
    setError("");
    setDone("");
    setAppUpd({ running: true, phase: "check", percent: 5, message: "正在启动自动更新…" });
    try {
      const initial = await api.applyAppUpdate();
      setAppUpd(initial);
    } catch (e) {
      setAppUpd(null);
      setError(`启动自动更新失败：${e.message || e}`);
      return;
    }

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.appUpdateStatus();
        setAppUpd(s);
        if (s.phase === "restarting" || s.restarting || s.phase === "done") {
          clearInterval(pollRef.current);
          writeSeen({
            ...(remoteBank ? { bank_version: remoteBank } : {}),
            ...(remoteApp ? { app_version: remoteApp } : {}),
          });
          setDone(s.message || "更新完成，正在自动重启应用...");
          waitAndReload();
        } else if (!s.running && s.phase === "error") {
          clearInterval(pollRef.current);
          setError(s.message || s.result?.detail || "自动更新失败，请点击下方手动下载链接更新");
        }
      } catch {
        // 进程已退出进入 _apply_update.bat 替换阶段 → 转为等待新进程端口恢复
        clearInterval(pollRef.current);
        setAppUpd((prev) => ({
          ...(prev || {}),
          running: false,
          phase: "restarting",
          percent: 100,
          restarting: true,
          message: "更新完成，正在自动重启应用...",
        }));
        setDone("更新完成，正在自动重启应用...");
        waitAndReload();
      }
    }, 450);
  };

  const doSync = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.syncBank();
      if (r?.ok) {
        setDone(r.detail || "已同步最新题库与笔记（保留个人刷题记录）");
        writeSeen({
          ...(remoteBank ? { bank_version: remoteBank } : {}),
          ...(remoteApp ? { app_version: remoteApp } : {}),
        });
        setTimeout(() => {
          setOpen(false);
          if (r.total) window.location.reload();
        }, 1400);
      } else {
        setError(r?.detail || "同步失败");
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const isAppUpdating = !!(appUpd?.running || appUpd?.restarting);
  const appPct = Math.max(0, Math.min(100, Number(appUpd?.percent) || 0));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-5"
      data-update-prompt="1"
    >
      <div
        className="absolute inset-0 scrim-45 backdrop-blur-md"
        onClick={() => dismiss(false)}
      />
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="relative w-full max-w-[460px] overflow-hidden rounded-[22px] border border-ink-950/10 bg-white p-5 shadow-bento"
      >
        <button
          onClick={() => dismiss(false)}
          disabled={isAppUpdating}
          className="btn-ghost absolute right-3 top-3 px-1.5 py-1 disabled:opacity-40"
          title="稍后再说"
        >
          <X className="h-3.5 w-3.5" />
        </button>

        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-apple-blue/12 text-apple-blue">
            {hasApp ? <Sparkles className="h-3.5 w-3.5" /> : <CloudDownload className="h-3.5 w-3.5" />}
          </span>
          <h2 className="text-[16.5px] font-semibold tracking-[-0.01em]">
            {hasApp ? "发现客户端新版本" : "题库与笔记有新内容"}
          </h2>
        </div>

        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-900/62">
          {hasBank && hasApp
            ? "客户端与题库均有更新。可一键自动下载更新并重启，你的 API Key 与刷题进度会完整保留。"
            : hasBank
              ? "仓库里有新的章节笔记映射与解析缓存，同步后立刻生效，错题记录和个人设置不受影响。"
              : "仓库发布了新版客户端，支持一键自动拉取更新包并热替换重启（个人配置与做题记录不受影响）。"}
        </p>

        {/* 客户端更新 */}
        {hasApp && (
          <div className="mt-3 rounded-2xl border border-apple-blue/22 bg-apple-blue/[0.06] p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] font-semibold text-apple-blue">
                客户端 {info?.release?.tag || (remoteApp ? `v${remoteApp.replace(/^v/i, "")}` : "")}
              </span>
              <span className="text-[11px] text-ink-900/42">
                当前 v{meta?.app_version || info?.app_version}
              </span>
            </div>
            {releaseNotes && (
              <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-900/72">
                {releaseNotes
                  .split("\n")
                  .filter((l) => l.trim())
                  .slice(0, 4)
                  .join(" · ")}
              </p>
            )}
          </div>
        )}

        {/* 题库更新 */}
        {hasBank && (
          <div className="mt-2.5 rounded-2xl border border-ink-950/8 bg-ink-950/[0.025] p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] font-semibold text-ink-900/72">题库</span>
              <span className="tabular-nums text-[11px] text-ink-900/42">
                {remoteBank || "未标注版本"}
              </span>
            </div>
            <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-900/72">
              {changelog}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-900/42">
              {stats.total_questions ? <span>{stats.total_questions} 道题</span> : null}
              {stats.matched_notes ? <span>{stats.matched_notes} 篇笔记</span> : null}
              {stats.media_count ? <span>{stats.media_count} 张配图</span> : null}
            </div>
          </div>
        )}

        {/* 自动更新进度条 */}
        {appUpd && (appUpd.running || appUpd.restarting) && (
          <div className="mt-3 rounded-xl border border-apple-blue/25 bg-apple-blue/[0.06] p-3">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="flex items-center gap-1.5 font-medium text-apple-blue">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {appUpd.message || "正在更新应用…"}
              </span>
              <span className="tabular-nums text-ink-900/60">{appPct}%</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-950/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-apple-blue to-apple-teal transition-all duration-300"
                style={{ width: `${Math.max(6, appPct)}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-xl border border-apple-red/30 bg-apple-red/[0.08] px-3 py-2 text-[11.5px] leading-relaxed text-apple-red">
            {error}
          </p>
        )}
        {done && (
          <p className="mt-3 flex items-start gap-1.5 rounded-xl border border-apple-green/30 bg-apple-green/[0.08] px-3 py-2 text-[11.5px] leading-relaxed text-apple-green">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{done}</span>
          </p>
        )}

        <div className="mt-4 space-y-1.5">
          {hasApp && (
            <button
              onClick={doAppUpdate}
              disabled={isAppUpdating || busy}
              className="btn-primary w-full justify-center py-2 text-[12.5px] disabled:opacity-60"
            >
              {isAppUpdating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              {appUpd?.restarting
                ? "更新完成，正在自动重启应用..."
                : appUpd?.running
                  ? `正在更新 (${appPct}%)…`
                  : "⚡ 一键自动更新并重启"}
            </button>
          )}
          {hasBank && (
            <button
              onClick={doSync}
              disabled={busy || isAppUpdating || (!!done && !hasApp)}
              className={`${hasApp ? "btn-ghost" : "btn-primary"} w-full justify-center py-2 text-[12.5px] disabled:opacity-60`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
              {busy ? "正在同步题库…" : "立即同步题库"}
            </button>
          )}
          {hasApp && releaseUrl && (
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost w-full justify-center py-2 text-[12px]"
              data-release-link="1"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              手动前往 GitHub 下载 ({info?.release?.tag || remoteApp})
              <ArrowUpRight className="h-3 w-3 opacity-60" />
            </a>
          )}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button
              onClick={() => dismiss(true)}
              disabled={isAppUpdating}
              className="text-[11px] text-ink-900/42 underline-offset-2 hover:text-ink-900/72 hover:underline disabled:opacity-40"
              data-dismiss="1"
            >
              这个版本不再提示
            </button>
            <button
              onClick={() => dismiss(false)}
              disabled={isAppUpdating}
              className="text-[11.5px] text-ink-900/52 hover:text-ink-900/80 disabled:opacity-40"
            >
              稍后再说
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
