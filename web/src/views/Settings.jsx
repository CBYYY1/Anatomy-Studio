import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, Brain, Check, ChevronDown, CloudDownload, Download, Eye,
  EyeOff, Gauge, Image as ImageIcon, KeyRound, Loader2, Palette, Pin,
  RefreshCw, Save, Sparkles, Trash2, Upload, X, Zap,
} from "lucide-react";
import { api } from "../api";
import { useStore, DEFAULT_SETTINGS } from "../store";

/* ------------------------------------------------------------------ 小组件 */

function Switch({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-on={on ? "true" : "false"}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`switch ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
    />
  );
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([k, label]) => (
        <button
          key={k}
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children, stack }) {
  return (
    <div className={`row ${stack ? "flex-col items-stretch gap-2" : ""}`}>
      <div className={stack ? "" : "min-w-0"}>
        <p className="text-[13px] font-medium text-ink-900/90">{label}</p>
        {hint && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-900/45">{hint}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function Group({ title, desc, children, icon: Icon }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        {Icon && <Icon className="h-3.5 w-3.5 text-ink-900/40" />}
        <h3 className="text-[12.5px] font-semibold tracking-tight text-ink-900/72">
          {title}
        </h3>
        {desc && <span className="text-[11px] text-ink-900/35">· {desc}</span>}
      </div>
      <div className="group-card">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ 模型选择器 */

/** 可打字、可搜索、可拉取的模型 Combobox + 常用胶囊。
 *  设计原则：输入框永远是唯一真值来源（手填任意模型 ID 都能用），
 *  下拉列表只是「候选」，胶囊只是「快捷方式」。 */
function ModelPicker({
  value, onChange, presets = [], fetched = [], pinned = [],
  fetching, fetchMsg, onFetch, onPin, labelOf,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const popRef = useRef(null);

  // 合并候选：钉住 → 平台实时拉取 → 内置预设，去重保序
  const all = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const src of [pinned, fetched, presets]) {
      for (const m of src || []) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        out.push(m);
      }
    }
    return out;
  }, [pinned, fetched, presets]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
    return base.slice(0, 80);
  }, [all, query]);

  // 弹层用 portal 挂到 body：设置卡片的 overflow-hidden / 滚动容器都会裁掉它
  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flip = below < 260 && r.top > below;
    setRect({
      left: r.left, width: r.width,
      top: flip ? undefined : r.bottom + 6,
      bottom: flip ? window.innerHeight - r.top + 6 : undefined,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (boxRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onMove = () => place();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  useEffect(() => { setActive(0); }, [query, open]);

  const pick = useCallback((m) => {
    onChange(m);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }, [onChange]);

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && shown[active]) { e.preventDefault(); pick(shown[active]); }
      else setOpen(false);
    } else if (e.key === "Escape") {
      setOpen(false);
      e.stopPropagation();
    }
  };

  // 胶囊：钉住的 → 平台拉到的 → 当前服务商预设前 6 个
  const pills = useMemo(() => {
    const seen = new Set();
    const out = [];
    const sources = [pinned, fetched.slice(0, 8), presets.slice(0, 6)];
    for (const src of sources) {
      for (const m of src) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        out.push(m);
      }
    }
    return out.slice(0, 12);
  }, [pinned, fetched, presets]);

  const isPinned = pinned.includes(value);

  const pop = open && rect && (
    <div
      ref={popRef}
      style={{
        position: "fixed", left: rect.left, width: rect.width,
        top: rect.top, bottom: rect.bottom, zIndex: 90,
      }}
      className="max-h-[264px] overflow-y-auto rounded-[11px] border border-ink-950/10 bg-white p-1 shadow-[0_18px_44px_-14px_rgba(0,0,0,.32)]"
    >
      {shown.length ? (
        shown.map((m, i) => (
          <div
            key={m}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(m); }}
            className={`flex cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] ${
              i === active ? "bg-ink-950/[0.07]" : ""
            } ${m === value ? "text-apple-blue font-semibold" : "text-ink-900/85"}`}
          >
            <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
            {labelOf?.[m] && (
              <span className="shrink-0 text-[10.5px] text-ink-900/38">{labelOf[m]}</span>
            )}
            {pinned.includes(m) && (
              <Pin className="h-2.5 w-2.5 shrink-0 fill-current text-apple-yellow" />
            )}
          </div>
        ))
      ) : (
        <p className="px-2 py-2 text-[11.5px] leading-relaxed text-ink-900/45">
          {all.length
            ? "没有匹配的模型。按下 Enter 直接使用当前输入的值。"
            : "还没有候选 —— 点右侧「同步」拉取平台模型，或直接手填任意模型 ID。"}
        </p>
      )}
    </div>
  );

  return (
    <div ref={boxRef} className="w-full">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            value={open ? query || value : value}
            onChange={(e) => {
              onChange(e.target.value);
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={(e) => {
              e.target.select();      // 聚焦全选：直接打字就是替换，不用先删
              setOpen(true);
              setQuery("");
            }}
            onKeyDown={onKey}
            placeholder="直接输入模型 ID，例如 deepseek-v4.1"
            className="inset w-full pr-8 font-mono text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-900/35" />
        </div>

        <button
          type="button"
          onClick={() => onPin?.(value, !isPinned)}
          title={isPinned ? "取消常用" : "钉为常用"}
          disabled={!value}
          className={`btn-ghost shrink-0 px-2 py-1.5 ${isPinned ? "text-apple-yellow" : ""} disabled:opacity-40`}
        >
          <Pin className={`h-3.5 w-3.5 ${isPinned ? "fill-current" : ""}`} />
        </button>

        <button
          type="button"
          onClick={onFetch}
          disabled={fetching}
          title="从平台实时拉取全部可用模型"
          className="btn-ghost shrink-0 whitespace-nowrap px-2.5 py-1.5 text-[11.5px] disabled:opacity-50"
        >
          {fetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          同步
        </button>
      </div>

      {createPortal(pop, document.body)}

      {pills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pills.map((m) => {
            const on = m === value;
            return (
              <button
                key={m}
                type="button"
                onClick={() => pick(m)}
                className={`rounded-full border px-2.5 py-[3px] font-mono text-[10.5px] transition-colors ${
                  on
                    ? "border-apple-blue/45 bg-apple-blue/12 font-semibold text-apple-blue"
                    : "border-ink-950/10 bg-ink-950/[0.035] text-ink-900/62 hover:bg-ink-950/[0.07] hover:text-ink-900/90"
                }`}
                title={labelOf?.[m] || m}
              >
                {m}
              </button>
            );
          })}
        </div>
      )}

      {fetchMsg && (
        <p className={`mt-1.5 text-[11px] ${fetchMsg.ok ? "text-apple-green" : "text-apple-red"}`}>
          {fetchMsg.text}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 设置页 */

const SECTIONS = [
  ["llm", "AI 引擎", Brain],
  ["kb", "知识库", ImageIcon],
  ["quiz", "刷题偏好", Zap],
  ["appearance", "外观", Palette],
  ["data", "数据与备份", Download],
];

export default function Settings() {
  const {
    settings, saveSettings, setSettingsOpen, setSettingsSection, settingsSection,
    flash, refreshProgress, refreshCram,
  } = useStore();

  const [cfg, setCfg] = useState(() => mergeDefaults(settings));
  const [providers, setProviders] = useState([]);
  const [reveal, setReveal] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [test, setTest] = useState(null);         // {phase, ms, detail}
  const [verify, setVerify] = useState(null);     // {ok, notes, images, ...}
  const [busy, setBusy] = useState("");           // 正在做哪个耗时操作
  const [confirmBox, setConfirmBox] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState(null); // {ok, text}

  const fileProgress = useRef(null);
  const fileBank = useRef(null);
  const saveRef = useRef(null);       // 供防抖 / 卸载时调用最新的 save
  const autoTimer = useRef(null);     // 自动保存的待执行定时器

  // 初始化：拉一次完整设置（含服务商预设）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.settings();
        if (!alive) return;
        setCfg(mergeDefaults(r));
        setProviders(r._providers || []);
        setKeyInput("");
        setDirty(false);
      } catch {
        /* 后端老版本没有这个接口时，静默降级到本地默认值 */
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { setSettingsSection(settingsSection || "llm"); }, [settingsSection, setSettingsSection]);

  const patch = useCallback((group, key, value) => {
    setCfg((c) => ({ ...c, [group]: { ...c[group], [key]: value } }));
    setDirty(true);
    // 外观是「所见即所得」的：改完立刻套到 <html data-*> 上，不用先保存
    if (group === "appearance") {
      const root = document.documentElement;
      const next = { ...cfg.appearance, [key]: value };
      root.dataset.theme = next.theme || "apple_dark";
      root.dataset.font = next.font_scale || "normal";
      root.dataset.motion = next.reduced_motion ? "reduced" : "normal";
    }
  }, [cfg.appearance]);

  const provider = useMemo(
    () => providers.find((p) => p.id === cfg.llm.provider) || null,
    [providers, cfg.llm.provider]
  );

  const pickProvider = useCallback(
    (id) => {
      const p = providers.find((x) => x.id === id);
      setCfg((c) => ({
        ...c,
        llm: {
          ...c.llm,
          provider: id,
          base_url: p?.base_url || c.llm.base_url,
          model: p?.models?.[0] || c.llm.model,
          // 换服务商 → 上一个平台拉到的模型列表不再适用（config.py 也按 base_url 校验）
          models: [],
          models_from: "",
        },
      }));
      setDirty(true);
      setTest(null);
      setFetchMsg(null);
    },
    [providers]
  );

  /** 实时拉取平台模型列表。silent 用于「测试连接成功后顺手同步」。 */
  const runFetchModels = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setFetchMsg(null);
    setFetching(true);
    try {
      const r = await api.fetchModels({
        base_url: cfg.llm.base_url,
        api_key: keyInput.trim() || cfg.llm.api_key,
        provider: cfg.llm.provider,
      });
      if (r.ok) {
        setCfg((c) => ({ ...c, llm: { ...c.llm, models: r.models, models_from: r.base_url } }));
        setFetchMsg({ ok: true, text: `已同步该平台 ${r.count} 个可用模型` });
      } else {
        setFetchMsg({ ok: false, text: `拉取失败：${r.detail}（可继续手填模型名）` });
      }
      return r;
    } catch (e) {
      setFetchMsg({ ok: false, text: `拉取失败：${e.message}（可继续手填模型名）` });
      return null;
    } finally {
      setFetching(false);
    }
  }, [cfg.llm.base_url, cfg.llm.api_key, cfg.llm.provider, keyInput]);

  /** 钉住 / 取消钉住某个模型（立刻落盘，不用点保存）。 */
  const togglePin = useCallback(async (model, pinned) => {
    if (!model) return;
    try {
      const r = await api.pinModel(model, pinned);
      setCfg((c) => ({ ...c, llm: { ...c.llm, pinned: r.pinned } }));
      flash(pinned ? `已钉为常用：${model}` : `已取消常用：${model}`);
    } catch (e) {
      flash(`操作失败：${e.message}`, "bad");
    }
  }, [flash]);

  /** silent：自动保存时不打扰（不弹 toast、不显示保存按钮的 spin）。 */
  const save = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSaving(true);
    try {
      const body = {
        llm: { ...cfg.llm, api_key: keyInput.trim() || cfg.llm.api_key },
        knowledge_base: cfg.knowledge_base,
        quiz_preferences: cfg.quiz_preferences,
        appearance: cfg.appearance,
        update: cfg.update,
      };
      if (!keyInput.trim()) delete body.llm.api_key;   // 没改 Key 就不要覆盖
      await saveSettings(body);
      setKeyInput("");
      setDirty(false);
      if (!silent) flash("设置已保存");
      return true;
    } catch (e) {
      flash(`保存失败：${e.message}`, "bad");
      return false;
    } finally {
      if (!silent) setSaving(false);
    }
  }, [cfg, keyInput, saveSettings, flash]);

  saveRef.current = save;

  // 自动保存：任何改动停手 800ms 就落盘，不必再记着点「保存」
  useEffect(() => {
    if (!dirty) return;
    if (autoTimer.current) window.clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(() => {
      autoTimer.current = null;
      saveRef.current?.({ silent: true });
    }, 800);
    return () => {
      if (autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
    };
  }, [dirty, cfg]);

  // 关窗 / 切页 / 直接关浏览器：把没来得及防抖的改动立刻落盘
  useEffect(() => {
    return () => {
      if (autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
        saveRef.current?.({ silent: true });
      }
    };
  }, []);

  useEffect(() => {
    function onHide() {
      if (document.visibilityState === "hidden" && autoTimer.current) {
        window.clearTimeout(autoTimer.current);
        autoTimer.current = null;
        saveRef.current?.({ silent: true });
      }
    }
    window.addEventListener("visibilitychange", onHide);
    return () => window.removeEventListener("visibilitychange", onHide);
  }, []);

  async function runTest() {
    setTest({ phase: "running" });
    try {
      const r = await api.testLlm({
        base_url: cfg.llm.base_url,
        api_key: keyInput.trim() || cfg.llm.api_key,
        model: cfg.llm.model,
        provider: cfg.llm.provider,
      });
      setTest({ phase: r.ok ? "ok" : "fail", ms: r.ms, detail: r.detail || r.reply });
      // 连通了就顺手把该平台在线的模型全拉一遍（失败不打扰）
      if (r.ok) runFetchModels({ silent: true });
    } catch (e) {
      setTest({ phase: "fail", detail: e.message });
    }
  }

  async function runVerify() {
    setVerify({ checking: true });
    setBusy("verify");
    try {
      const r = await api.verifyObsidian(cfg.knowledge_base.obsidian_vault_path);
      setVerify(r);
      if (r.ok) {
        setCfg((c) => ({
          ...c,
          knowledge_base: { ...c.knowledge_base, obsidian_vault_name: r.vault_name || c.knowledge_base.obsidian_vault_name },
        }));
        setDirty(true);
      }
    } catch (e) {
      setVerify({ ok: false, detail: e.message });
    } finally {
      setBusy("");
    }
  }

  async function doReset(scope) {
    setBusy("reset");
    try {
      await api.resetProgress(true, scope);
      await refreshProgress();
      await refreshCram(20);
      flash(scope === "wrong" ? "错题本已清空" : "全部学习数据已重置");
      setConfirmBox(null);
    } catch (e) {
      flash(`重置失败：${e.message}`, "bad");
    } finally {
      setBusy("");
    }
  }

  async function doClearKey() {
    setBusy("key");
    try {
      await api.clearKey();
      setCfg((c) => ({ ...c, llm: { ...c.llm, api_key: "", configured: false } }));
      setKeyInput("");
      flash("本地 API Key 已清除");
      setConfirmBox(null);
    } catch (e) {
      flash(`清除失败：${e.message}`, "bad");
    } finally {
      setBusy("");
    }
  }

  async function doImportProgress(file) {
    if (!file) return;
    setBusy("import");
    try {
      const r = await api.importProgress(file);
      await refreshProgress();
      await refreshCram(20);
      flash(`已导入 ${r.imported} 条记录${r.skipped ? `，跳过 ${r.skipped} 条题库里没有的题` : ""}`);
    } catch (e) {
      flash(`导入失败：${e.message}`, "bad");
    } finally {
      setBusy("");
    }
  }

  async function doUpdateBank(file) {
    if (!file) return;
    setBusy("bank");
    try {
      const r = await api.updateBank(file);
      flash(`题库已更新：${r.total} 道题${r.orphan ? `，${r.orphan} 条旧错题已无对应题目` : ""}`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      flash(`题库更新失败：${e.message}`, "bad");
    } finally {
      setBusy("");
    }
  }

  const kb = cfg.knowledge_base;
  const isBuiltin = kb.mode === "builtin";
  const keyMasked = cfg.llm.api_key || "";
  const keyPlaceholder = cfg.llm.configured ? keyMasked : "sk-…（本地 Ollama 可留空）";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 scrim-45 backdrop-blur-md"
        onClick={() => setSettingsOpen(false)}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
        className="relative flex max-h-[86vh] w-full max-w-[940px] overflow-hidden rounded-[20px] border border-ink-950/10 bg-white shadow-[0_30px_90px_-20px_rgba(0,0,0,.5)]"
      >
        {/* ---------- 左：毛玻璃分类导航 */}
        <aside className="hidden w-[196px] shrink-0 border-r border-ink-950/8 bg-ink-950/[0.028] p-3 sm:block">
          <div className="mb-3 flex items-center gap-2 px-2 py-1">
            <span className="flex h-6 w-6 items-center justify-center rounded-[8px] bg-gradient-to-br from-apple-blue to-apple-purple text-white">
              <Sparkles className="h-3 w-3" />
            </span>
            <span className="text-[13px] font-semibold tracking-tight">设置</span>
          </div>
          <nav className="space-y-0.5">
            {SECTIONS.map(([k, label, Icon]) => (
              <button
                key={k}
                onClick={() => setSettingsSection(k)}
                className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors ${
                  settingsSection === k
                    ? "bg-ink-950/[0.075] text-ink-900"
                    : "text-ink-900/60 hover:bg-ink-950/[0.04] hover:text-ink-900/85"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </nav>
          <p className="mt-4 px-2 text-[10.5px] leading-relaxed text-ink-900/32">
            配置只存在本机
            <br />
            <span className="font-mono">data/user_config.json</span>
          </p>
        </aside>

        {/* ---------- 右：分组卡片 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-ink-950/8 px-5 py-3">
            <h2 className="text-[15px] font-semibold tracking-tight">
              {SECTIONS.find((s) => s[0] === settingsSection)?.[1] || "设置"}
            </h2>
            <span className="text-[11px] text-ink-900/35">Ctrl + , 可随时开关</span>
            <div className="ml-auto flex items-center gap-2">
              {dirty && (
                <span className="rounded-full bg-apple-yellow/16 px-2 py-0.5 text-[10.5px] font-semibold text-apple-yellow">
                  自动保存中…
                </span>
              )}
              <button
                onClick={() => save()}
                disabled={saving}
                className="btn-primary px-3.5 py-1.5 text-[12px] disabled:opacity-55"
                title="改动会自动保存，这里可以立即保存"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                保存
              </button>
              <button
                onClick={() => setSettingsOpen(false)}
                className="btn-ghost px-2 py-1.5"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {settingsSection === "llm" && (
              <LLMSection
                cfg={cfg} patch={patch} providers={providers} provider={provider}
                pickProvider={pickProvider} keyInput={keyInput} setKeyInput={setKeyInput}
                keyPlaceholder={keyPlaceholder} reveal={reveal} setReveal={setReveal}
                test={test} runTest={runTest} setTest={setTest}
                fetching={fetching} fetchMsg={fetchMsg}
                runFetchModels={runFetchModels} togglePin={togglePin}
              />
            )}

            {settingsSection === "kb" && (
              <KBSection
                cfg={cfg} patch={patch} kb={kb} isBuiltin={isBuiltin}
                verify={verify} runVerify={runVerify} busy={busy}
              />
            )}

            {settingsSection === "quiz" && (
              <QuizSection cfg={cfg} patch={patch} />
            )}

            {settingsSection === "appearance" && (
              <AppearanceSection cfg={cfg} patch={patch} />
            )}

            {settingsSection === "data" && (
              <DataSection
                busy={busy} fileProgress={fileProgress} fileBank={fileBank}
                doImportProgress={doImportProgress} doUpdateBank={doUpdateBank}
                setConfirmBox={setConfirmBox} cfg={cfg} patch={patch}
              />
            )}
          </div>
        </div>
      </motion.div>

      {/* ---------- 二次确认弹窗 */}
      <AnimatePresence>
        {confirmBox && (
          <ConfirmDialog
            {...confirmBox}
            busy={busy}
            onCancel={() => setConfirmBox(null)}
            onOk={() => (confirmBox.kind === "clearKey" ? doClearKey() : doReset(confirmBox.scope))}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ 五大分组 */

function LLMSection({
  cfg, patch, providers, provider, pickProvider, keyInput, setKeyInput,
  keyPlaceholder, reveal, setReveal, test, runTest, setTest,
  fetching, fetchMsg, runFetchModels, togglePin,
}) {
  const presetModels = provider?.models || [];
  const fetchedModels = useMemo(
    () => (cfg.llm.models_from === cfg.llm.base_url ? cfg.llm.models || [] : []),
    [cfg.llm.models, cfg.llm.models_from, cfg.llm.base_url]
  );
  return (
    <>
      <Group
        title="服务商"
        desc="选一个预设，Base URL 与模型名会自动填好"
        icon={Gauge}
      >
        <Row label="服务商预设" hint={provider ? `${provider.base_url}` : "手动填写任意 OpenAI 兼容接口"}>
          <div className="relative">
            <select
              value={cfg.llm.provider}
              onChange={(e) => pickProvider(e.target.value)}
              className="inset appearance-none pr-8"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              {!providers.length && <option value={cfg.llm.provider}>DeepSeek 官方</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-900/40" />
          </div>
        </Row>

        <Row label="Base URL" hint="OpenAI 兼容的 /v1 根地址" stack>
          <input
            value={cfg.llm.base_url}
            onChange={(e) => patch("llm", "base_url", e.target.value)}
            className="inset w-full font-mono text-[12px]"
            placeholder="https://api.deepseek.com"
          />
        </Row>

        <Row
          label="模型名称"
          hint={
            fetchedModels.length
              ? `已从平台同步 ${fetchedModels.length} 个模型 · 可直接手填任意 ID`
              : presetModels.length
              ? `${presetModels.length} 个内置推荐 · 可手填任意 ID 或点「同步」拉取`
              : "直接输入任意模型 ID"
          }
          stack
        >
          <ModelPicker
            value={cfg.llm.model}
            onChange={(v) => patch("llm", "model", v)}
            presets={presetModels}
            fetched={fetchedModels}
            pinned={cfg.llm.pinned || []}
            fetching={fetching}
            fetchMsg={fetchMsg}
            onFetch={() => runFetchModels()}
            onPin={togglePin}
            labelOf={provider?.labels}
          />
        </Row>
      </Group>

      <Group title="API Key" desc="只存在你自己的电脑上" icon={KeyRound}>
        <Row
          label="密钥"
          hint={
            cfg.llm.provider === "ollama"
              ? "本地 Ollama 不需要 Key，留空即可"
              : cfg.llm.configured
              ? `已保存：${keyPlaceholder}`
              : "还没有配置 Key；不配也能用「本地推导」解析"
          }
          stack
        >
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type={reveal ? "text" : "password"}
                value={keyInput}
                onChange={(e) => { setKeyInput(e.target.value); setTest(null); }}
                placeholder={keyPlaceholder}
                className="inset w-full pr-9 font-mono text-[12px]"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-900/40 hover:text-ink-900/70"
                title={reveal ? "隐藏" : "显示"}
              >
                {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <button
              onClick={runTest}
              disabled={test?.phase === "running"}
              className="btn-ghost shrink-0 px-3 py-1.5 text-[12px] disabled:opacity-55"
            >
              {test?.phase === "running" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              测试连接
            </button>
          </div>

          <AnimatePresence>
            {test && test.phase !== "running" && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={`mt-2 rounded-xl px-3 py-2 text-[11.5px] leading-snug ${
                  test.phase === "ok"
                    ? "bg-apple-green/10 text-apple-green"
                    : "bg-apple-red/10 text-apple-red"
                }`}
              >
                {test.phase === "ok" ? (
                  <span className="flex items-center gap-1.5 font-medium">
                    <Check className="h-3 w-3" />
                    连接成功{test.ms ? ` · ${test.ms}ms` : ""}
                  </span>
                ) : (
                  <span className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0 break-words">{test.detail || "连接失败"}</span>
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </Row>
      </Group>

      <Group title="解析策略" desc="决定什么时候花 Token" icon={Sparkles}>
        <Row label="AI 靶向解析触发时机" stack>
          <Seg
            value={cfg.llm.trigger_mode}
            onChange={(v) => patch("llm", "trigger_mode", v)}
            options={[
              ["on_wrong", "仅答错时"],
              ["always", "每次答题"],
              ["manual", "仅手动点击"],
            ]}
          />
          <p className="text-[11px] leading-snug text-ink-900/40">
            已有缓存的题永远秒开，不消耗 Token。
          </p>
        </Row>

        <Row label="解析风格" stack>
          <Seg
            value={cfg.llm.style}
            onChange={(v) => patch("llm", "style", v)}
            options={[
              ["rigorous", "严谨教材风"],
              ["mnemonic", "通俗助记风"],
            ]}
          />
        </Row>
      </Group>
    </>
  );
}

function KBSection({ cfg, patch, kb, isBuiltin, verify, runVerify, busy }) {
  return (
    <>
      <Group title="运行模式" desc="决定解析证据从哪来" icon={ImageIcon}>
        <Row
          label="知识库模式"
          hint={
            isBuiltin
              ? "用题库包里打包好的笔记片段与预生成解析，无需安装 Obsidian"
              : "从你本机的 Obsidian 库实时读取笔记、图谱与双链"
          }
          stack
        >
          <Seg
            value={kb.mode}
            onChange={(v) => patch("knowledge_base", "mode", v)}
            options={[
              ["builtin", "📦 内置静态"],
              ["obsidian", "🔮 本地 Obsidian"],
            ]}
          />
        </Row>
      </Group>

      <AnimatePresence initial={false}>
        {!isBuiltin && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-2 overflow-hidden"
          >
            <Group title="本地库路径" desc="指向你的 Obsidian vault 文件夹" icon={ImageIcon}>
              <Row label="Vault 路径" stack>
                <input
                  value={kb.obsidian_vault_path}
                  onChange={(e) => patch("knowledge_base", "obsidian_vault_path", e.target.value)}
                  placeholder="D:\\Obsidian\\人体结构学"
                  className="inset w-full font-mono text-[12px]"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={runVerify}
                    disabled={busy === "verify"}
                    className="btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-55"
                  >
                    {busy === "verify" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    验证路径
                  </button>
                  {verify && !verify.checking && (
                    <span
                      className={`text-[11.5px] ${
                        verify.ok ? "text-apple-green" : "text-apple-red"
                      }`}
                    >
                      {verify.ok
                        ? `成功识别到 ${verify.notes} 篇 Markdown 笔记 · ${verify.images} 张图`
                        : verify.detail || "路径无效"}
                    </span>
                  )}
                </div>
              </Row>

              <Row label="Vault 名称" hint="用于 obsidian:// 一键唤起">
                <input
                  value={kb.obsidian_vault_name}
                  onChange={(e) => patch("knowledge_base", "obsidian_vault_name", e.target.value)}
                  placeholder="人体结构学"
                  className="inset w-[180px]"
                />
              </Row>
            </Group>

            <Group title="反向写回" desc="把高频错题写进你的笔记" icon={Upload}>
              <Row
                label="错题印记写回"
                hint="累计错到阈值时，往对应 .md 笔记里插一段「刷题高频雷区」Callout"
              >
                <Switch
                  on={!!kb.enable_writeback}
                  onChange={(v) => patch("knowledge_base", "enable_writeback", v)}
                />
              </Row>
              <Row label="触发阈值" hint="错满几次后写回">
                <Seg
                  value={String(kb.writeback_threshold)}
                  onChange={(v) => patch("knowledge_base", "writeback_threshold", Number(v))}
                  options={[["2", "2 次"], ["3", "3 次"], ["5", "5 次"]]}
                />
              </Row>
            </Group>
          </motion.div>
        )}
      </AnimatePresence>

      {isBuiltin && (
        <div className="rounded-xl border border-apple-blue/22 bg-apple-blue/[0.06] px-3.5 py-3 text-[11.5px] leading-relaxed text-ink-900/62">
          内置模式下列表里的笔记原文、选项矩阵、图谱都来自题库包，谁都开箱即用。
          如果你自己也用 Obsidian，切到「本地 Obsidian」就能读到你最新改过的笔记、
          用 <span className="font-mono">obsidian://</span> 一键跳转、并把错题印记写回。
        </div>
      )}
    </>
  );
}

function QuizSection({ cfg, patch }) {
  const q = cfg.quiz_preferences;
  return (
    <>
      <Group title="审题捉虫" desc="否定词 / 方位词 / 光镜电镜层级词" icon={Zap}>
        <Row label="高亮时机" stack>
          <Seg
            value={q.highlight_mode}
            onChange={(v) => patch("quiz_preferences", "highlight_mode", v)}
            options={[
              ["always", "答题前始终"],
              ["after", "仅作答后复盘"],
              ["off", "关闭"],
            ]}
          />
        </Row>
      </Group>

      <Group title="节奏" desc="答对之后怎么走" icon={Gauge}>
        <Row label="答对自动进入下一题" hint="答错永远停留，方便你看解析">
          <Switch
            on={!!q.auto_next_on_correct}
            onChange={(v) => patch("quiz_preferences", "auto_next_on_correct", v)}
          />
        </Row>
        <Row label="自动切换延迟" hint={`${q.auto_next_delay_ms} ms`} stack>
          <input
            type="range"
            min={300}
            max={3000}
            step={100}
            value={q.auto_next_delay_ms}
            onChange={(e) => patch("quiz_preferences", "auto_next_delay_ms", Number(e.target.value))}
            disabled={!q.auto_next_on_correct}
            className="w-full accent-apple-blue disabled:opacity-40"
          />
        </Row>
      </Group>

      <Group title="急救池" desc="考前突击队列的进出标准" icon={Sparkles}>
        <Row label="连续答对几次算攻克" hint="达到后移出急救池（默认 3）">
          <Seg
            value={String(q.cram_mastery_streak)}
            onChange={(v) => patch("quiz_preferences", "cram_mastery_streak", Number(v))}
            options={[["2", "2 次"], ["3", "3 次"], ["5", "5 次"]]}
          />
        </Row>
      </Group>

      <Group title="键盘" desc="实验室里刷得快一点" icon={Gauge}>
        <Row label="启用全局快捷键">
          <Switch
            on={!!q.enable_shortcuts}
            onChange={(v) => patch("quiz_preferences", "enable_shortcuts", v)}
          />
        </Row>
        <div className="row block">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] text-ink-900/55">
            {[
              ["A – E / 1 – 5", "选择选项"],
              ["Enter", "提交 / 下一题"],
              ["← / →", "上一题 / 下一题"],
              ["空格", "展开或收起解析"],
              ["Esc", "关闭抽屉 / 灯箱"],
              ["Ctrl + ,", "打开设置"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <kbd className="rounded bg-ink-950/10 px-1.5 py-0.5 font-mono text-[10.5px]">{k}</kbd>
                <span className="text-ink-900/45">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </Group>
    </>
  );
}

function AppearanceSection({ cfg, patch }) {
  const a = cfg.appearance;
  return (
    <>
      <Group title="主题" desc="换肤即时生效" icon={Palette}>
        <Row label="外观" stack>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["apple_dark", "深空暗黑", "#0a0a0c", "#1c1c1e"],
              ["oled", "纯黑 OLED", "#000000", "#0e0e0f"],
              ["paper", "纸质浅色", "#f5f5f7", "#ffffff"],
            ].map(([k, label, bg, surface]) => (
              <button
                key={k}
                onClick={() => patch("appearance", "theme", k)}
                className={`group rounded-xl border p-2 transition-all ${
                  a.theme === k
                    ? "border-apple-blue/60 ring-2 ring-apple-blue/20"
                    : "border-ink-950/10 hover:border-ink-950/22"
                }`}
              >
                <div
                  className="h-12 w-full rounded-lg border border-ink-950/10 p-1.5"
                  style={{ background: bg }}
                >
                  <div className="h-3 w-2/3 rounded" style={{ background: surface }} />
                  <div className="mt-1 h-2 w-1/2 rounded" style={{ background: `${surface}aa` }} />
                </div>
                <p className="mt-1.5 text-center text-[11px] font-medium text-ink-900/72">
                  {label}
                </p>
              </button>
            ))}
          </div>
        </Row>
      </Group>

      <Group title="文字" desc="投影仪上看就看这个" icon={Gauge}>
        <Row label="题干字号" stack>
          <Seg
            value={a.font_scale}
            onChange={(v) => patch("appearance", "font_scale", v)}
            options={[["normal", "标准"], ["large", "偏大"], ["xlarge", "特大"]]}
          />
        </Row>
      </Group>

      <Group title="动效" desc="低配电脑或图书馆里更安分" icon={Zap}>
        <Row label="减弱动态效果" hint="关掉高斯模糊与弹簧动画">
          <Switch
            on={!!a.reduced_motion}
            onChange={(v) => patch("appearance", "reduced_motion", v)}
          />
        </Row>
      </Group>
    </>
  );
}

function DataSection({
  busy, fileProgress, fileBank, doImportProgress, doUpdateBank, setConfirmBox,
  cfg, patch,
}) {
  const u = cfg.update || {};
  const [upd, setUpd] = useState(null);
  const [checking, setChecking] = useState(false);

  const runCheck = async (fresh = true) => {
    setChecking(true);
    try {
      setUpd(await api.updaterCheck(fresh));
    } catch (e) {
      setUpd({ ok: false, detail: String(e.message || e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Group title="云端同步" desc="从 GitHub 仓库拉取最新的题库、笔记映射与配图" icon={CloudDownload}>
        <Row
          label="仓库地址"
          hint="owner/repo，例如 someone/Anatomy-Studio；填好后重启同步胶囊即可用"
        >
          <input
            value={u.repo || ""}
            onChange={(e) => patch("update", "repo", e.target.value)}
            placeholder="someone/Anatomy-Studio"
            className="inset w-[220px] text-[12px]"
          />
        </Row>
        <Row label="分支" hint="默认 main">
          <input
            value={u.branch || "main"}
            onChange={(e) => patch("update", "branch", e.target.value)}
            placeholder="main"
            className="inset w-[120px] text-[12px]"
          />
        </Row>
        <Row label="启动时自动检查" hint="打开软件时静默问一次仓库有没有新内容">
          <Switch
            on={!!u.auto_check}
            onChange={(v) => patch("update", "auto_check", v)}
          />
        </Row>
        <Row
          label="检测到更新时主动弹窗"
          hint="有新题库或新版客户端时，直接在应用内弹出提示（同一版本只弹一次）"
        >
          <Switch
            on={!!u.notify}
            onChange={(v) => patch("update", "notify", v)}
          />
        </Row>
        <Row label="当前题库版本" hint="来自随包发布的 data/version.json">
          <span className="tabular-nums text-[11.5px] text-ink-900/62">
            {u.last_bank_version || "未标注"}
          </span>
        </Row>
        <Row
          label="立即检查"
          hint={
            u.last_sync_at
              ? `上次同步：${new Date(u.last_sync_at * 1000).toLocaleString("zh-CN")}`
              : "还没有同步过"
          }
        >
          <button
            onClick={() => runCheck(true)}
            disabled={checking}
            className="btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-55"
          >
            {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            检查更新
          </button>
        </Row>
        {upd && (
          <div className="px-4 pb-3 text-[11.5px] leading-relaxed">
            {upd.ok === false ? (
              <p className="text-apple-red">{upd.detail || "连不上 GitHub"}</p>
            ) : (
              <p className="text-ink-900/62">
                客户端 {upd.app_version}
                {upd.has_new_app_release && upd.release
                  ? ` → 有新版 ${upd.release.tag}`
                  : " · 已是最新"}
                <br />
                题库{" "}
                {upd.remote_manifest?.bank_version || upd.local_bank_version || "未标注"}
                {upd.has_new_question_bank ? " · 远端有更新" : " · 已是最新"}
                {upd.commit?.message ? `（${upd.commit.message}）` : ""}
                {upd.source ? (
                  <span className="text-ink-900/36"> · 检查方式：版本清单</span>
                ) : (
                  <span className="text-ink-900/36"> · 检查方式：GitHub API</span>
                )}
              </p>
            )}
            {upd.release?.url && (
              <a
                href={upd.release.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-apple-blue hover:underline"
              >
                打开 Releases
              </a>
            )}
          </div>
        )}
      </Group>

      <Group title="个人学习档案" desc="错题、收藏、作答历史" icon={Download}>
        <Row label="导出备份" hint="下载 user_progress.json，换电脑或升级前先存一份">
          <a href={api.exportProgress()} className="btn-ghost px-3 py-1.5 text-[12px]">
            <Download className="h-3 w-3" />
            导出 .json
          </a>
        </Row>
        <Row label="导入恢复" hint="旧版软件备份的进度可以直接恢复">
          <input
            ref={fileProgress}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => doImportProgress(e.target.files?.[0])}
          />
          <button
            onClick={() => fileProgress.current?.click()}
            disabled={busy === "import"}
            className="btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-55"
          >
            {busy === "import" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            选择文件
          </button>
        </Row>
      </Group>

      <Group title="题库热更新" desc="导入我分享给你的新版题库包" icon={Upload}>
        <Row
          label="更新 questions.json"
          hint="只替换题目与解析，你的错题计数、收藏、作答历史全部保留"
        >
          <input
            ref={fileBank}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => doUpdateBank(e.target.files?.[0])}
          />
          <button
            onClick={() => fileBank.current?.click()}
            disabled={busy === "bank"}
            className="btn-ghost px-3 py-1.5 text-[12px] disabled:opacity-55"
          >
            {busy === "bank" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            导入题库包
          </button>
        </Row>
      </Group>

      <Group title="危险操作" desc="都带二次确认" icon={AlertTriangle}>
        <Row label="仅清空错题本" hint="把每道题的错误次数归零，其它记录保留">
          <button
            onClick={() =>
              setConfirmBox({
                kind: "reset",
                scope: "wrong",
                title: "清空错题本？",
                body: "所有题目的错误次数与连对记录会归零，作答历史与收藏保留。",
                okText: "清空错题本",
              })
            }
            className="btn-ghost px-3 py-1.5 text-[12px]"
          >
            清空
          </button>
        </Row>
        <Row label="重置全部学习数据" hint="回到刚装好的状态，题库文件不动">
          <button
            onClick={() =>
              setConfirmBox({
                kind: "reset",
                scope: "all",
                title: "重置全部学习数据？",
                body: "错题、收藏、每日热力、作答历史全部清空，无法撤销。",
                okText: "全部重置",
              })
            }
            className="btn-danger px-3 py-1.5 text-[12px]"
          >
            <Trash2 className="h-3 w-3" />
            重置
          </button>
        </Row>
        <Row label="清除本地 API Key" hint="换人用这台电脑时点一下">
          <button
            onClick={() =>
              setConfirmBox({
                kind: "clearKey",
                title: "清除 API Key？",
                body: "清掉后 AI 靶向解析会退回到「本地推导」，题库与进度不受影响。",
                okText: "清除 Key",
              })
            }
            className="btn-ghost px-3 py-1.5 text-[12px]"
          >
            清除
          </button>
        </Row>
      </Group>
    </>
  );
}

function ConfirmDialog({ title, body, okText = "确认", onOk, onCancel, busy }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 scrim-45 backdrop-blur-sm" onClick={onCancel} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        className="relative w-full max-w-[380px] rounded-[18px] border border-ink-950/10 bg-white p-5 text-center"
      >
        <AlertTriangle className="mx-auto mb-3 h-7 w-7 text-apple-red" />
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-900/58">{body}</p>
        <div className="mt-4 flex justify-center gap-2">
          <button onClick={onCancel} className="btn-ghost px-4 py-2 text-[12.5px]">
            取消
          </button>
          <button
            onClick={onOk}
            disabled={busy}
            className="btn-danger px-4 py-2 text-[12.5px] disabled:opacity-55"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {okText}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ 工具 */

function mergeDefaults(s) {
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    llm: { ...DEFAULT_SETTINGS.llm, ...(s?.llm || {}) },
    knowledge_base: { ...DEFAULT_SETTINGS.knowledge_base, ...(s?.knowledge_base || {}) },
    quiz_preferences: { ...DEFAULT_SETTINGS.quiz_preferences, ...(s?.quiz_preferences || {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(s?.appearance || {}) },
    update: { ...DEFAULT_SETTINGS.update, ...(s?.update || {}) },
  };
}
