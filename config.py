"""用户配置中心（共享版核心）

设计要点
--------
* 单一事实来源是 `data/user_config.json`。所有个人设置（大模型 Key、Obsidian
  库路径、刷题偏好、外观、知识库模式）都存这里，**不再硬编码在代码或 .env 里**。
* 该文件必须进 `.gitignore`：分发时不能把开发者的 API Key 带给同学。
* 首次启动若文件不存在，会做一次「向后兼容迁移」：
    - 旧的 `config.json`（vault 路径）→ `knowledge_base.obsidian_vault_path`
    - 旧的 `.env`（DEEPSEEK_API_KEY 等）→ `llm.*`
  这样开发者自己那台机器升级后不用重新填一遍。
* 读取带 mtime 缓存（每请求都要用，文件虽小但别反复 parse）；
  写入走「临时文件 + os.replace」原子落盘。
* 前端拿到的配置里 `api_key` 一律脱敏成 `sk-••••1234`；只有
  `?reveal=1` 才回明文（用于「小眼睛」按钮）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from threading import Lock


def base_dir() -> Path:
    """可写根目录：PyInstaller 打包后是 .exe 所在目录，开发时是源码目录。

    这一点是便携版的命根子 —— 同学的刷题进度、填的 API Key、新生成的 AI 解析
    都必须落在 .exe 旁边，绝不能进 PyInstaller 的临时解压目录（_MEIPASS，
    进程一退就删）。所以这里刻意**不用** _MEIPASS。
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


HERE = base_dir()
DATA = HERE / "data"
CONFIG_PATH = DATA / "user_config.json"
EXAMPLE_CONFIG = DATA / "user_config.example.json"
VERSION_FILE = DATA / "version.json"          # 随仓库发布的版本清单（见 updater.py）
LEGACY_CONFIG = HERE / "config.json"
ENV_FILE = HERE / ".env"

# ---------------------------------------------------------------- 默认配置

# 客户端版本号：与 GitHub Release 的 tag 对比，判断「有没有新版客户端」。
APP_VERSION = "2.2.0"

# 开源仓库（owner/name）。默认已绑定本仓库，开箱即可直接同步；
# 若你自行 fork 维护，可在 设置 → 数据与备份 → 云端同步 里改仓库地址。
GITHUB_REPO = "CBYYY1/Anatomy-Studio"

DEFAULT = {
    "llm": {
        "provider": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "",
        "model": "deepseek-chat",
        "trigger_mode": "on_wrong",      # on_wrong | always | manual
        "style": "rigorous",             # rigorous | mnemonic
        "models": [],                    # 上次从平台拉取到的模型 id（缓存）
        "models_from": "",               # 上面这份缓存是从哪个 base_url 拉的
        "pinned": [],                    # 自己固定的常用模型
    },
    "knowledge_base": {
        "mode": "builtin",               # builtin | obsidian
        "obsidian_vault_path": "",
        "obsidian_vault_name": "",
        "enable_writeback": False,
        "writeback_threshold": 3,
    },
    "quiz_preferences": {
        "highlight_mode": "always",      # always | after | off
        "auto_next_on_correct": False,
        "auto_next_delay_ms": 800,
        "cram_mastery_streak": 3,
        "enable_shortcuts": True,
    },
    "appearance": {
        "theme": "apple_dark",           # apple_dark | oled | paper
        "font_scale": "normal",          # normal | large | xlarge
        "reduced_motion": False,
    },
    "update": {
        "repo": GITHUB_REPO,             # owner/name，设置里可改
        "branch": "main",
        "last_sync_at": 0,               # 上次成功同步的 unix 时间戳
        "last_sync_commit": "",          # 上次同步到的 sha，用来判断「有没有新东西」
        "last_bank_version": "",         # 上次同步到的题库版本（data/version.json 的 bank_version）
        "auto_check": True,              # 启动时静默检查一次
        "notify": True,                  # 检测到更新时主动弹窗提示
    },
}

# 服务端自身监听参数不进用户配置（同学不该看见），沿用旧 config.json 的同名字段
SERVER_DEFAULT = {"host": "127.0.0.1", "port": 8788}
DEFAULT_PORTABLE_PORT = 18080      # 便携版用 18080，避开开发机上常被占的 8788

PROVIDERS = [
    {"id": "deepseek", "label": "DeepSeek 官方",
     "base_url": "https://api.deepseek.com",
     "models": ["deepseek-chat", "deepseek-reasoner"],
     "labels": {"deepseek-chat": "deepseek-chat（V3）",
                "deepseek-reasoner": "deepseek-reasoner（R1）"}},
    {"id": "siliconflow", "label": "硅基流动 SiliconFlow",
     "base_url": "https://api.siliconflow.cn/v1",
     "models": ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1",
                "Pro/deepseek-ai/DeepSeek-V3", "Pro/deepseek-ai/DeepSeek-R1",
                "Qwen/Qwen2.5-72B-Instruct", "Qwen/QwQ-32B"]},
    {"id": "dashscope", "label": "阿里云百炼 DashScope",
     "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
     "models": ["qwen-plus", "qwen-max", "qwen-turbo", "qwq-32b",
                "deepseek-r1", "deepseek-v3", "qwen-long"]},
    {"id": "ark", "label": "火山引擎方舟 / 豆包",
     "base_url": "https://ark.cn-beijing.volces.com/api/v3",
     "models": ["deepseek-r1-250120", "deepseek-v3-241226",
                "doubao-1-5-pro-32k-250115"]},
    {"id": "moonshot", "label": "月之暗面 Kimi",
     "base_url": "https://api.moonshot.cn/v1",
     "models": ["moonshot-v1-8k", "moonshot-v1-32k",
                "moonshot-v1-128k", "kimi-latest"]},
    {"id": "zhipu", "label": "智谱清言 GLM",
     "base_url": "https://open.bigmodel.cn/api/paas/v4",
     "models": ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-zero-preview"]},
    {"id": "ollama", "label": "本地 Ollama（离线免费）",
     "base_url": "http://localhost:11434/v1",
     "models": ["qwen2.5:7b", "qwen2.5:14b", "deepseek-r1:7b",
                "deepseek-r1:14b", "llama3.1:8b"]},
    {"id": "custom", "label": "自定义 OpenAI 兼容接口",
     "base_url": "", "models": []},
]

PROVIDER_IDS = [p["id"] for p in PROVIDERS]

# ---------------------------------------------------------------- 深合并


def _merge(base: dict, patch: dict) -> dict:
    """只合并已知键，避免前端塞进乱七八糟的字段污染配置文件。"""
    out = json.loads(json.dumps(base))
    for k, v in (patch or {}).items():
        if k not in out:
            continue
        if isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


_COERCE = {
    "enable_writeback": bool, "enable_shortcuts": bool,
    "auto_next_on_correct": bool, "reduced_motion": bool,
    "auto_check": bool, "last_sync_at": int, "notify": bool,
    "writeback_threshold": int, "auto_next_delay_ms": int,
    "cram_mastery_streak": int,
}
_ENUMS = {
    "provider": set(PROVIDER_IDS),
    "trigger_mode": {"on_wrong", "always", "manual"},
    "style": {"rigorous", "mnemonic"},
    "mode": {"builtin", "obsidian"},
    "highlight_mode": {"always", "after", "off"},
    "theme": {"apple_dark", "oled", "paper"},
    "font_scale": {"normal", "large", "xlarge"},
}


def _str_list(v, limit: int = 400) -> list[str]:
    """把任意输入收拾成去重、去空、限长的字符串列表。"""
    out, seen = [], set()
    if isinstance(v, str):
        v = [x for x in v.split("\n")]
    if not isinstance(v, (list, tuple)):
        return []
    for item in v:
        s = str(item or "").strip()
        if not s or s in seen or len(s) > 200:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= limit:
            break
    return out


def sanitize(raw: dict) -> dict:
    """把前端传上来的东西收拾干净：类型、枚举、数值范围。"""
    cfg = _merge(DEFAULT, raw)
    for group in cfg.values():
        if not isinstance(group, dict):
            continue
        for k, fn in _COERCE.items():
            if k in group:
                try:
                    group[k] = fn(group[k])
                except (TypeError, ValueError):
                    group[k] = DEFAULT[
                        next(g for g in DEFAULT if k in DEFAULT[g])][k]
        for k, allowed in _ENUMS.items():
            if k in group and group[k] not in allowed:
                group[k] = DEFAULT[
                    next(g for g in DEFAULT if k in DEFAULT[g])][k]
    cfg["knowledge_base"]["writeback_threshold"] = max(
        1, min(10, int(cfg["knowledge_base"]["writeback_threshold"])))
    cfg["quiz_preferences"]["auto_next_delay_ms"] = max(
        300, min(3000, int(cfg["quiz_preferences"]["auto_next_delay_ms"])))
    cfg["quiz_preferences"]["cram_mastery_streak"] = max(
        1, min(10, int(cfg["quiz_preferences"]["cram_mastery_streak"])))
    for k in ("base_url", "model", "api_key", "provider", "models_from",
              "obsidian_vault_path", "obsidian_vault_name"):
        group_name = "llm" if k in ("base_url", "model", "api_key", "provider",
                                    "models_from") else "knowledge_base"
        cfg[group_name][k] = str(cfg[group_name].get(k) or "").strip()
    cfg["llm"]["models"] = _str_list(cfg["llm"].get("models"))
    cfg["llm"]["pinned"] = _str_list(cfg["llm"].get("pinned"), limit=40)
    upd = cfg["update"]
    upd["repo"] = str(upd.get("repo") or "").strip().strip("/")
    # owner/name 只允许这些字符，防止有人把完整 URL 填进来导致拼接出畸形地址
    if upd["repo"] and not all(c.isalnum() or c in "-_./" for c in upd["repo"]):
        upd["repo"] = GITHUB_REPO
    upd["branch"] = (str(upd.get("branch") or "main").strip() or "main")
    upd["last_sync_commit"] = str(upd.get("last_sync_commit") or "").strip()
    upd["last_bank_version"] = str(upd.get("last_bank_version") or "").strip()
    upd["last_sync_at"] = max(0, int(upd.get("last_sync_at") or 0))
    return cfg


# ---------------------------------------------------------------- 迁移

_ENV_IMPORT = {
    "DEEPSEEK_API_KEY": ("llm", "api_key"),
    "OPENAI_API_KEY": ("llm", "api_key"),
    "DEEPSEEK_BASE_URL": ("llm", "base_url"),
    "OPENAI_BASE_URL": ("llm", "base_url"),
    "DEEPSEEK_MODEL": ("llm", "model"),
    "OPENAI_MODEL": ("llm", "model"),
}


def _migrate() -> dict:
    """首次启动：先照 `.example.json` 铺一份，再从旧 config.json / .env 搬设置。"""
    cfg = json.loads(json.dumps(DEFAULT))
    # 仓库里带的模板优先（脱敏、模式为 builtin），比硬编码 DEFAULT 更好维护
    if EXAMPLE_CONFIG.is_file():
        try:
            cfg = _merge(cfg, json.loads(EXAMPLE_CONFIG.read_text(encoding="utf-8")))
        except Exception:
            pass

    if LEGACY_CONFIG.exists():
        try:
            legacy = json.loads(LEGACY_CONFIG.read_text(encoding="utf-8"))
        except Exception:
            legacy = {}
        vault = (legacy.get("vault") or "").strip()
        if vault:
            cfg["knowledge_base"]["obsidian_vault_path"] = vault
            cfg["knowledge_base"]["obsidian_vault_name"] = (
                legacy.get("vault_name") or os.path.basename(vault.rstrip("\\/")))
            cfg["knowledge_base"]["mode"] = "obsidian"

    if ENV_FILE.exists():
        try:
            for raw in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k in _ENV_IMPORT and v:
                    grp, field = _ENV_IMPORT[k]
                    if not cfg[grp][field]:
                        cfg[grp][field] = v
        except Exception:
            pass
    return sanitize(cfg)


# ---------------------------------------------------------------- 读写

_lock = Lock()
_cache = {"mtime": 0.0, "cfg": None}


def _read_disk() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load() -> dict:
    """读配置（带 mtime 缓存）。文件被手工改过也能立刻生效。"""
    try:
        mtime = CONFIG_PATH.stat().st_mtime
    except OSError:
        mtime = 0.0
    with _lock:
        if _cache["cfg"] is not None and _cache["mtime"] == mtime and mtime:
            return _cache["cfg"]
    if not CONFIG_PATH.exists():
        cfg = _migrate()
        save(cfg, _skip_lock=True)
    else:
        cfg = sanitize(_read_disk())
    with _lock:
        _cache["mtime"] = mtime
        _cache["cfg"] = cfg
    return cfg


def save(cfg: dict, _skip_lock=False) -> dict:
    cfg = sanitize(cfg)
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    os.replace(tmp, CONFIG_PATH)
    with _lock:
        try:
            _cache["mtime"] = CONFIG_PATH.stat().st_mtime
        except OSError:
            _cache["mtime"] = 0.0
        _cache["cfg"] = cfg
    return cfg


def update(patch: dict) -> dict:
    cfg = load()
    merged = _merge(cfg, patch or {})
    return save(merged)


# ---------------------------------------------------------------- 便捷读取


def llm() -> dict:
    return load()["llm"]


def knowledge_base() -> dict:
    return load()["knowledge_base"]


def quiz_prefs() -> dict:
    return load()["quiz_preferences"]


def appearance() -> dict:
    return load()["appearance"]


def updater() -> dict:
    return load()["update"]


def repo() -> str:
    """当前生效的 GitHub 仓库（owner/name）；空表示不检查更新。"""
    return (updater().get("repo") or "").strip().strip("/")


def server() -> dict:
    out = dict(SERVER_DEFAULT)
    if getattr(sys, "frozen", False):
        out["port"] = DEFAULT_PORTABLE_PORT      # 便携版默认换一个不常用的端口
    if LEGACY_CONFIG.exists():
        try:
            legacy = json.loads(LEGACY_CONFIG.read_text(encoding="utf-8"))
            for k in ("host", "port"):
                if legacy.get(k):
                    out[k] = legacy[k]
        except Exception:
            pass
    out["port"] = int(os.environ.get("ANATOMY_PORT") or out["port"])
    return out


def vault_path() -> Path | None:
    """当前生效的 Obsidian 库路径；builtin 模式或未配置时返回 None。"""
    kb = knowledge_base()
    if kb.get("mode") != "obsidian":
        return None
    p = (kb.get("obsidian_vault_path") or "").strip()
    if not p:
        return None
    path = Path(p).expanduser()
    return path if path.is_dir() else None


def vault_name() -> str:
    kb = knowledge_base()
    if kb.get("mode") != "obsidian":
        return "内置题库"
    name = (kb.get("obsidian_vault_name") or "").strip()
    if name:
        return name
    v = vault_path()
    return v.name if v else "内置题库"


def llm_configured() -> bool:
    return bool(llm().get("api_key"))


# ---------------------------------------------------------------- 模型列表缓存

def remember_models(base_url: str, models: list[str]) -> dict:
    """把拉取到的模型列表写进配置缓存（同一个 base_url 才覆盖）。"""
    return update({"llm": {"models": list(models),
                           "models_from": (base_url or "").strip().rstrip("/")}})


def cached_models(base_url: str = "") -> list[str]:
    """读缓存；传了 base_url 且与缓存来源不一致时返回空（避免展示别家模型）。"""
    llm = load()["llm"]
    base = (base_url or "").strip().rstrip("/")
    if base and (llm.get("models_from") or "").strip().rstrip("/") != base:
        return []
    return list(llm.get("models") or [])


# ---------------------------------------------------------------- 同步记录

def remember_sync(commit_sha: str = "", at: int | None = None,
                  bank_version: str = "") -> dict:
    """记录一次成功的题库同步（下次 check 用它判断远端有没有新东西）。"""
    patch = {
        "last_sync_commit": str(commit_sha or "").strip(),
        "last_sync_at": int(at if at is not None else time.time()),
    }
    if bank_version:
        patch["last_bank_version"] = str(bank_version).strip()
    return update({"update": patch})


# ---------------------------------------------------------------- 脱敏

def mask_key(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:3]}••••••••{key[-4:]}"


def public(cfg: dict | None = None) -> dict:
    """给前端的版本：Key 脱敏，附带服务商预设。"""
    cfg = json.loads(json.dumps(cfg or load()))
    cfg["llm"]["api_key"] = mask_key(cfg["llm"].get("api_key", ""))
    cfg["llm"]["configured"] = bool((load()["llm"].get("api_key") or "").strip())
    cfg["_providers"] = PROVIDERS
    cfg["_vault_name"] = vault_name()
    cfg["_vault_effective"] = str(vault_path() or "")
    return cfg


def touch_mtime():
    """测试/调试用：让缓存立即失效。"""
    with _lock:
        _cache["mtime"] = 0.0
        _cache["cfg"] = None
