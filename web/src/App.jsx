import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, AlertTriangle, BookOpen, LayoutGrid, Library, Loader2,
  Settings as SettingsIcon, Sparkles, Target,
} from "lucide-react";
import { useStore } from "./store";
import SyncChip from "./components/SyncChip";
import UpdatePrompt from "./components/UpdatePrompt";
import Home from "./views/Home";
import Practice from "./views/Practice";
import Analysis from "./views/Analysis";
import LibraryView from "./views/LibraryView";
import Settings from "./views/Settings";

const NAV = [
  { key: "home", label: "概览", icon: LayoutGrid },
  { key: "practice", label: "练习", icon: Target },
  { key: "analysis", label: "分析", icon: Activity },
  { key: "library", label: "题库", icon: Library },
];

function parseHash() {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const view = NAV.some((n) => n.key === parts[0]) ? parts[0] : "home";
  return { view, id: parts[1] || null, params: new URLSearchParams(query || "") };
}

export default function App() {
  const { ready, error, meta, stats, toast, settingsOpen, setSettingsOpen } = useStore();
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = useCallback((view, id) => {
    window.location.hash = `#/${view}${id ? "/" + id : ""}`;
  }, []);

  if (error) {
    return (
      <Shell>
        <div className="mx-auto mt-24 max-w-xl">
          <div className="card border-apple-red/25 p-8 text-center">
            <AlertTriangle className="mx-auto mb-4 h-9 w-9 text-apple-red" />
            <h1 className="text-[20px] font-semibold">后端没连上</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-900/62">
              {error}
            </p>
            <p className="mt-4 rounded-xl bg-ink-950/5 px-4 py-3 text-left font-mono text-[12px] text-ink-900/52">
              在 studio 目录运行：python server.py
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  if (!ready) {
    return (
      <Shell>
        <div className="flex h-[70vh] flex-col items-center justify-center gap-4">
          <Loader2 className="h-7 w-7 animate-spin text-ink-900/48" />
          <p className="text-[13px] text-ink-900/48">正在加载题库数据…</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell nav={NAV} route={route} go={go} meta={meta} stats={stats}>
      <AnimatePresence mode="wait">
        <motion.div
          key={route.view + (route.id || "")}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
        >
          {route.view === "home" && <Home go={go} />}
          {route.view === "practice" && <Practice go={go} initialId={route.id} params={route.params} />}
          {route.view === "analysis" && <Analysis go={go} />}
          {route.view === "library" && <LibraryView go={go} />}
        </motion.div>
      </AnimatePresence>

      <AnimatePresence>
        {settingsOpen && <Settings key="settings" />}
      </AnimatePresence>

      {/* 启动时自动检测，有新版题库 / 新版客户端就主动弹一次 */}
      <UpdatePrompt />

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className={`fixed bottom-7 left-1/2 z-50 -translate-x-1/2 rounded-full border px-5 py-2.5 text-[13px] font-medium shadow-glow backdrop-blur-xl ${
              toast.tone === "bad"
                ? "border-apple-red/35 bg-apple-red/15 text-apple-red"
                : "border-ink-950/12 bg-white text-ink-900/90"
            }`}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </Shell>
  );
}

function Shell({ children, nav, route, go, meta, stats }) {
  const { setSettingsOpen } = useStore();
  return (
    <div className="relative min-h-full">
      <div className="aurora">
        <i />
      </div>

      {nav && (
        <header className="sticky top-0 z-30 border-b border-ink-950/[0.07] bg-white/72 backdrop-blur-2xl">
          <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-6 px-6">
            <button
              onClick={() => go("home")}
              className="flex items-center gap-2.5 text-[14.5px] font-semibold tracking-tight"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-gradient-to-br from-apple-blue to-apple-purple text-[13px] text-white">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              Anatomy Studio
            </button>

            <nav className="flex items-center gap-1">
              {nav.map((n) => {
                const Icon = n.icon;
                const active = route.view === n.key;
                return (
                  <button
                    key={n.key}
                    onClick={() => go(n.key)}
                    className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                      active
                        ? "bg-ink-950/[0.07] text-ink-900"
                        : "text-ink-900/52 hover:bg-ink-950/[0.04] hover:text-ink-900/80"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {n.label}
                  </button>
                );
              })}
            </nav>

            <div className="ml-auto flex items-center gap-2.5">
              {stats && (
                <>
                  <span className="chip tabular-nums">
                    <BookOpen className="h-3 w-3" />
                    {stats.seen} / {stats.total}
                  </span>
                  <span className="chip tabular-nums">
                    {(stats.accuracy * 100).toFixed(0)}% 正确率
                  </span>
                  {stats.urgent > 0 && (
                    <span className="chip border-apple-red/25 bg-apple-red/10 tabular-nums text-apple-red/90">
                      <AlertTriangle className="h-3 w-3" />
                      {stats.urgent} 待抢救
                    </span>
                  )}
                </>
              )}
              {meta && (
                <span className="hidden text-[11.5px] text-ink-900/36 lg:inline">
                  {meta.vault_name}
                </span>
              )}
              <SyncChip />
              {nav && (
                <button
                  onClick={() => setSettingsOpen(true)}
                  title="设置（Ctrl + ,）"
                  className="btn-ghost px-2.5 py-1.5"
                >
                  <SettingsIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </header>
      )}

      <main className="relative z-10 mx-auto max-w-[1240px] px-6 pb-24 pt-8">
        {children}
      </main>
    </div>
  );
}
