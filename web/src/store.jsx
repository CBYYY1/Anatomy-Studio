import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

const Ctx = createContext(null);

export const TODAY = () => new Date().toISOString().slice(0, 10);

/** 前端兜底默认值，必须与后端 config.py 的 DEFAULT 保持一致。 */
export const DEFAULT_SETTINGS = {
  llm: {
    provider: "deepseek",
    base_url: "https://api.deepseek.com",
    api_key: "",
    model: "deepseek-chat",
    trigger_mode: "on_wrong",
    style: "rigorous",
    models: [],
    models_from: "",
    pinned: [],
    configured: false,
  },
  knowledge_base: {
    mode: "builtin",
    obsidian_vault_path: "",
    obsidian_vault_name: "",
    enable_writeback: false,
    writeback_threshold: 3,
  },
  quiz_preferences: {
    highlight_mode: "always",
    auto_next_on_correct: false,
    auto_next_delay_ms: 800,
    cram_mastery_streak: 3,
    enable_shortcuts: true,
  },
  appearance: {
    theme: "apple_dark",
    font_scale: "normal",
    reduced_motion: false,
  },
  update: {
    repo: "",
    branch: "main",
    last_sync_at: 0,
    last_sync_commit: "",
    last_bank_version: "",
    auto_check: true,
    notify: true,
  },
};

function emptyProgress() {
  return { version: 1, questions: {}, daily: {}, sessions: [] };
}

export function StoreProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState([]);                 // 精简列表
  const [progress, setProgress] = useState(emptyProgress());
  const [counts, setCounts] = useState({ seen: 0, wrong: 0, starred: 0, mastered: 0 });
  const [cramItems, setCramItems] = useState([]);
  const [toast, setToast] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("llm");

  const detailCache = useRef(new Map());                // id -> 完整题（含 option_matrix / images）

  const flash = useCallback((msg, tone = "ok") => {
    setToast({ msg, tone, at: Date.now() });
    setTimeout(() => setToast((t) => (t && Date.now() - t.at >= 2400 ? null : t)), 2600);
  }, []);

  const refreshCram = useCallback(async (n = 20) => {
    try {
      const r = await api.cram(n);
      setCramItems(r.items || []);
    } catch {
      setCramItems([]);
    }
  }, []);

  const refreshProgress = useCallback(async () => {
    const r = await api.progress();
    setProgress(r.progress || emptyProgress());
    setCounts(r.counts || { seen: 0, wrong: 0, starred: 0, mastered: 0 });
    return r;
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await api.settings();
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      return s;
    } catch {
      return null;
    }
  }, []);

  /** 保存设置：后端返回 sanitize 后的权威版本，直接覆盖本地。 */
  const saveSettings = useCallback(
    async (patch) => {
      const r = await api.putSettings(patch);
      setSettings({ ...DEFAULT_SETTINGS, ...r });
      // 设置影响急救池（cram_mastery_streak）与题库状态，顺手刷新
      refreshCram(20).catch(() => {});
      return r;
    },
    [refreshCram]
  );

  const invalidateQuestion = useCallback((id) => {
    detailCache.current.delete(id);
  }, []);

  /** 云端热同步之后重载题库与元信息（配图/新增题目立刻可见）。 */
  const refreshAll = useCallback(async () => {
    try {
      const [m, qs] = await Promise.all([api.meta(), api.questions()]);
      setMeta(m);
      setList(qs);
      detailCache.current.clear();      // 题库变了，旧详情缓存一律作废
      await refreshProgress();
      await refreshCram(20);
      return true;
    } catch (e) {
      flash(`刷新失败：${e.message || e}`, "bad");
      return false;
    }
  }, [flash, refreshCram, refreshProgress]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, qs] = await Promise.all([api.meta(), api.questions()]);
        if (!alive) return;
        setMeta(m);
        setList(qs);
        await refreshSettings();
        await refreshProgress();
        await refreshCram(20);
        setReady(true);
      } catch (e) {
        if (alive) setError(e.message || String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshProgress, refreshCram, refreshSettings]);

  // 外观设置落到 <html> 上：主题 / 字号 / 减弱动效都由 CSS 变量接管
  useEffect(() => {
    const ap = settings.appearance || DEFAULT_SETTINGS.appearance;
    const root = document.documentElement;
    root.dataset.theme = ap.theme || "apple_dark";
    root.dataset.font = ap.font_scale || "normal";
    root.dataset.motion = ap.reduced_motion ? "reduced" : "full";
  }, [settings.appearance]);

  // Ctrl+, / Cmd+, 唤起设置（macOS 习惯）
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 取完整题目（带 Obsidian 证据），带内存缓存。 */
  const getQuestion = useCallback(async (id) => {
    if (detailCache.current.has(id)) return detailCache.current.get(id);
    const q = await api.question(id);
    detailCache.current.set(id, q);
    return q;
  }, []);

  const record = useCallback(
    async (q, picked) => {
      const answer = new Set(q.answer);
      const ok =
        answer.size === picked.length && picked.every((p) => answer.has(p));
      try {
        const r = await api.answer({ id: q.id, ok, picked });
        const rec = r.record;
        setProgress((prev) => {
          const next = { ...prev, questions: { ...prev.questions, [q.id]: rec } };
          const day = TODAY();
          const d = next.daily[day] || { n: 0, ok: 0 };
          // 后端已写盘，这里同步前端计数（避免二次请求）
          next.daily = { ...next.daily, [day]: d };
          return next;
        });
        await refreshProgress();
        await refreshCram(20);
        return { ok, rec };
      } catch (e) {
        flash(`进度保存失败：${e.message}`, "bad");
        return { ok, rec: progress.questions[q.id] };
      }
    },
    [flash, refreshCram, refreshProgress, progress.questions]
  );

  const toggleStar = useCallback(
    async (id) => {
      try {
        const r = await api.star(id);
        await refreshProgress();
        await refreshCram(20);
        flash(r.starred ? "已加入收藏" : "已取消收藏");
        return r.starred;
      } catch (e) {
        flash(`收藏失败：${e.message}`, "bad");
        return false;
      }
    },
    [flash, refreshCram, refreshProgress]
  );

  const stats = useMemo(() => {
    const total = list.length || 0;
    const seen = counts.seen || 0;
    const recs = Object.values(progress.questions || {});
    const attempts = recs.reduce((s, r) => s + (r.seen || 0), 0);
    const correct = recs.reduce((s, r) => s + (r.correct || 0), 0);
    return {
      total,
      seen,
      coverage: total ? seen / total : 0,
      attempts,
      correct,
      accuracy: attempts ? correct / attempts : 0,
      wrong: counts.wrong || 0,
      starred: counts.starred || 0,
      mastered: counts.mastered || 0,
      urgent: cramItems.length,
    };
  }, [list.length, counts, progress.questions, cramItems.length]);

  const value = {
    ready, error, meta, list, progress, counts, stats, cramItems,
    getQuestion, record, toggleStar, refreshProgress, refreshCram,
    refreshAll, invalidateQuestion,
    toast, flash,
    settings, refreshSettings, saveSettings,
    settingsOpen, setSettingsOpen, settingsSection, setSettingsSection,
    quiz: settings.quiz_preferences || DEFAULT_SETTINGS.quiz_preferences,
    kb: settings.knowledge_base || DEFAULT_SETTINGS.knowledge_base,
    llm: settings.llm || DEFAULT_SETTINGS.llm,
    appearance: settings.appearance || DEFAULT_SETTINGS.appearance,
    update: settings.update || DEFAULT_SETTINGS.update,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore 必须在 StoreProvider 内使用");
  return v;
}

/** 按模块 / 章节 / 题型 / 关键词筛选，返回精简列表。
 *
 * chapter 既可以是单个章名，也可以是章名数组（多选）。
 * group 是「篇」级大分类（运动系统 / 内脏学 / …），与 chapter 同时给时取交集。
 */
export function filterList(list, { module, group, chapter, type, q, only }) {
  const kw = (q || "").trim();
  const wanted = Array.isArray(chapter) ? chapter.filter(Boolean) : chapter ? [chapter] : [];
  return list.filter((x) => {
    if (module && x.module !== module) return false;
    if (group && x.group !== group) return false;
    if (wanted.length && !wanted.includes(x.chapter)) return false;
    if (type && x.type !== type) return false;
    if (kw) {
      const hay = x.stem + " " + (x.keywords || []).join(" ") + " " + Object.keys(x).join("");
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}
