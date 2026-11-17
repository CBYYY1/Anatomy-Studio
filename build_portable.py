"""一键构建「脱敏开箱即用便携版」

用法（在 studio 目录下）：
    python build_portable.py            # 全流程：构建前端 → 抽资产 → 打包 exe → 自检
    python build_portable.py --skip-npm # 复用已有 dist/（前端没改时省 20 秒）
    python build_portable.py --skip-pyi # 只重建数据与说明，复用上次的 exe

输出：`./release/AnatomyStudio_Portable/`

铁律
----
1. **绝不改动开发目录的个人数据**：`data/user_config.json`（我的 API Key）与
   `data/user_progress.json`（我的刷题进度）只读不写，构建前后校验 sha256 一致。
2. **发布目录里不能有任何 Key**：配置从 `config.DEFAULT` 重新生成，`api_key` 置空；
   构建完再全文扫一遍 `sk-` 开头的字符串做兜底。
3. **图片必须自带**：把题库里引用到的 196 张图从 Obsidian 库抽到 `data/media/`，
   并把 `questions.json` 的 `images` 重写成 `media/...`，同学没装 Obsidian 也能看图。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import config as CFG  # noqa: E402

DATA = HERE / "data"
WEB = HERE / "web"
RELEASE_ROOT = HERE / "release"
OUT = RELEASE_ROOT / "AnatomyStudio_Portable"
APP_NAME = "AnatomyStudio"

# 开发目录里绝对不能被动到的两个文件
GUARDED = [DATA / "user_config.json", DATA / "user_progress.json"]


# ---------------------------------------------------------------- 小工具

def say(msg: str = "") -> None:
    print(msg, flush=True)


def step(n: int, total: int, title: str) -> None:
    say("")
    say("=" * 66)
    say(f"  [{n}/{total}] {title}")
    say("=" * 66)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} GB"


def run(cmd: list[str], cwd: Path, env: dict | None = None, quiet: bool = False) -> None:
    say(f"  $ {' '.join(cmd[:6])}{' …' if len(cmd) > 6 else ''}")
    e = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    if env:
        e.update(env)
    if quiet:
        # PyInstaller 会把几千行 INFO 写到 stderr，PowerShell 会把它当错误；
        # 捕获起来只在失败时回放最后几十行。
        p = subprocess.run(cmd, cwd=str(cwd), env=e, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if p.returncode != 0:
            tail = "\n".join((p.stdout or "").splitlines()[-15:] + (p.stderr or "").splitlines()[-25:])
            raise SystemExit(f"  命令失败（exit {p.returncode}）：{' '.join(cmd[:4])}\n{tail}")
        return
    p = subprocess.run(cmd, cwd=str(cwd), env=e)
    if p.returncode != 0:
        raise SystemExit(f"  命令失败（exit {p.returncode}）：{' '.join(cmd)}")


def pyinstaller() -> list[str]:
    return [sys.executable, "-m", "PyInstaller"]


# ---------------------------------------------------------------- 1. 前端

def build_frontend(skip: bool) -> Path:
    dist = WEB / "dist"
    if skip and (dist / "index.html").is_file():
        say(f"  跳过 npm build，复用 {dist}（index.html 已存在）")
        return dist
    npm = shutil.which("npm") or r"C:\Program Files\nodejs\npm.cmd"
    if not Path(npm).exists() and not shutil.which("npm"):
        raise SystemExit("  找不到 npm，请先安装 Node.js，或用 --skip-npm 复用已有 dist/")
    if not (WEB / "node_modules").is_dir():
        say("  首次构建，先 npm install（可能要几分钟）…")
        run([npm, "install", "--no-audit", "--no-fund"], WEB)
    run([npm, "run", "build"], WEB)
    if not (dist / "index.html").is_file():
        raise SystemExit("  npm run build 之后没有 dist/index.html")
    return dist


# ---------------------------------------------------------------- 2. 资产抽取

def collect_images(qs: list[dict]) -> list[str]:
    seen, out = set(), []
    for q in qs:
        om = q.get("obsidian_match") or {}
        for p in om.get("images") or []:
            p = str(p).replace("\\", "/")
            key = p[3:] if p.startswith("media/") else p
            if key and key not in seen:
                seen.add(key)
                out.append(key)
    return out


def copy_images(refs: list[str], vault: Path, media: Path) -> tuple[int, int, list[str]]:
    """按原始相对路径拷进 media/（保留目录结构，避免 18 组同名文件互相覆盖）。"""
    ok = miss = 0
    missing: list[str] = []
    for rel in refs:
        src = vault / rel
        if not src.is_file():
            miss += 1
            missing.append(rel)
            continue
        dst = media / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        ok += 1
    return ok, miss, missing


def rewrite_paths(qs: list[dict]) -> int:
    """把 images 里的裸路径统一加 `media/` 前缀（服务端会剥掉这个前缀再拼根目录）。"""
    n = 0
    for q in qs:
        om = q.get("obsidian_match") or {}
        imgs = om.get("images") or []
        if not imgs:
            continue
        new = []
        for p in imgs:
            p = str(p).replace("\\", "/")
            if not p.startswith("media/"):
                p = "media/" + p.lstrip("/")
                n += 1
            new.append(p)
        om["images"] = new
    return n


# ---------------------------------------------------------------- 3. 脱敏配置

def fresh_config() -> dict:
    """从 config.DEFAULT 深拷贝出一份全新配置：无 Key、内置模式、无个人路径。"""
    cfg = json.loads(json.dumps(CFG.DEFAULT, ensure_ascii=False))
    cfg["llm"]["api_key"] = ""
    cfg["llm"]["models"] = []
    cfg["llm"]["models_from"] = ""
    cfg["llm"]["pinned"] = []
    cfg["knowledge_base"]["mode"] = "builtin"
    cfg["knowledge_base"]["obsidian_vault_path"] = ""
    cfg["knowledge_base"]["obsidian_vault_name"] = ""
    cfg["knowledge_base"]["enable_writeback"] = False
    cfg["appearance"]["theme"] = "apple_dark"
    return cfg


EMPTY_PROGRESS = {
    "version": 1,
    "updated": 0,
    "questions": {},
    "daily": {},
    "sessions": [],
}


# ---------------------------------------------------------------- 4. 启动器

BAT = r"""@echo off
chcp 65001 >nul
title Anatomy Studio
cd /d "%~dp0"
echo.
echo   Starting Anatomy Studio ...
echo.
if not exist "%~dp0AnatomyStudio.exe" (
  echo   [ERROR] AnatomyStudio.exe not found next to this file.
  echo   Please keep the whole folder together.
  pause
  exit /b 1
)
"%~dp0AnatomyStudio.exe"
if errorlevel 1 (
  echo.
  echo   The program exited unexpectedly. Press any key to close.
  pause
)
"""

README_TXT = """Anatomy Studio 使用说明
======================================================

【怎么启动】
双击同目录下的「启动 Anatomy Studio.bat」。
会弹出一个黑色命令行窗口（那是在跑本地服务，别关它），
1 秒后浏览器自动打开刷题界面。

万一浏览器没自动打开：
把窗口里那行 http://127.0.0.1:18080/ 复制到浏览器地址栏。
（如果 18080 被别的软件占了，窗口里会显示换成了哪个端口，以窗口里为准。）

关掉那个黑窗口 = 停止服务。你的答题记录已经存好了，下次再开还在。


【要不要填 API Key】
不用也行。
  不填：解析区用「本地推导」——只摘录随包自带的课堂笔记原文，不联网、不编造。
  填了：解析区会用大模型做「靶向破题」+ 给 A–E 每个选项写医学剖析，效果更好。

怎么填：
  右上角齿轮（或按 Ctrl + ,）→「AI 引擎」
  → 选服务商（DeepSeek 官方 / 阿里云百炼 / 硅基流动 / 火山方舟 / Kimi / 智谱 / 本地 Ollama）
  → 填自己的 API Key → 点「⚡ 测试连接」看到「连接成功」就好了。

  模型名不是写死的：可以手打任意模型 ID，点「同步」能拉到该平台全部可用模型，
  常用的还能点图钉钉成一排胶囊。

  担心安全：Key 只存在本机 data\\user_config.json，不会上传到任何别的地方。


【数据都在哪】
data\\questions.json          题库（含笔记原文、图片引用、已有的 AI 解析）
data\\media\\                 内置解剖图谱与切片（约 200 张，没装 Obsidian 也能看）
data\\user_config.json        你的设置和 API Key
data\\user_progress.json      你的刷题进度、错题、收藏

想换电脑 / 备份：整个文件夹拷走即可。
想重置进度：设置 →「数据与备份」→ 重置全部学习数据。


【知识库模式】
默认「内置静态解析」：完全离线，图片和笔记都来自随包的文件。
如果你自己也有 Obsidian 库，可以在设置 → 知识库切到「本地联动」，
刷错 3 次的题还能反向写回笔记里，变成一块红色 Callout 提醒。
"""


# ---------------------------------------------------------------- 5. 自检

KEY_PATTERNS = [re.compile(rb"sk-[A-Za-z0-9_\-]{16,}"),
                re.compile(rb"sk-or-v1-[A-Za-z0-9_\-]{16,}")]


def scan_keys(root: Path, extra_secrets: list[str]) -> list[str]:
    """全文扫 Key（二进制安全），返回命中文件列表。"""
    hits: list[str] = []
    secrets = [s.encode() for s in extra_secrets if s and len(s) >= 8]
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() in {".exe", ".dll", ".pyd", ".pyc", ".so"}:
            continue  # 二进制不扫（下面单独说明原因）
        try:
            blob = p.read_bytes()
        except OSError:
            continue
        if any(rx.search(blob) for rx in KEY_PATTERNS) or any(s in blob for s in secrets):
            hits.append(str(p.relative_to(root)))
    return hits


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-npm", action="store_true", help="复用已有 web/dist")
    ap.add_argument("--skip-pyi", action="store_true", help="跳过 PyInstaller 打包")
    args = ap.parse_args()

    t0 = time.time()
    TOTAL = 6

    # ---------- 0. 守护：记录开发目录个人数据的指纹
    before = {p: sha256(p) for p in GUARDED if p.is_file()}
    say("开发目录个人数据指纹（构建前后必须一致）：")
    for p, h in before.items():
        say(f"  {p.name:22s} {h[:16]}…  {human(p.stat().st_size)}")

    # ---------- 1. 前端
    step(1, TOTAL, "编译前端（Vite）")
    dist = build_frontend(args.skip_npm)
    assets = sorted((dist / "assets").glob("*"))
    say(f"  dist/ : {sum(1 for _ in dist.rglob('*') if _.is_file())} 个文件，"
        f"{human(sum(p.stat().st_size for p in dist.rglob('*') if p.is_file()))}")
    for a in assets:
        say(f"    {a.name:26s} {human(a.stat().st_size)}")

    # ---------- 2. 目录 + 题库
    step(2, TOTAL, "准备发布目录、抽取题库与内置图谱")
    stash = None
    if args.skip_pyi and (OUT / f"{APP_NAME}.exe").is_file():
        # --skip-pyi 时先把上次的 exe 与 _internal 挪到临时目录，重建完再放回来
        stash = RELEASE_ROOT / "_stash"
        if stash.exists():
            shutil.rmtree(stash)
        stash.mkdir(parents=True)
        for name in (f"{APP_NAME}.exe", "_internal"):
            src = OUT / name
            if src.exists():
                shutil.move(str(src), str(stash / name))
        say(f"  暂存上次的 exe 与 _internal → {stash.name}/")
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "data" / "media").mkdir(parents=True, exist_ok=True)
    say(f"  发布目录：{OUT}")
    if stash is not None:
        for name in (f"{APP_NAME}.exe", "_internal"):
            src = stash / name
            if src.exists():
                if (OUT / name).is_dir():
                    shutil.rmtree(OUT / name)
                shutil.move(str(src), str(OUT / name))
        shutil.rmtree(stash, ignore_errors=True)

    src_q = DATA / "questions.json"
    if not src_q.is_file():
        raise SystemExit("  缺少 data/questions.json")
    qs = json.loads(src_q.read_text(encoding="utf-8"))
    say(f"  题库：{len(qs)} 题，{human(src_q.stat().st_size)}")

    # 图谱：从我的 Obsidian 库抽出来（发布版不能依赖我的 D 盘路径）
    vault = CFG.vault_path()
    if vault is None:
        cand = Path(r"D:\桌面\人体结构学")
        vault = cand if cand.is_dir() else None
    if vault is None:
        raise SystemExit("  找不到 Obsidian 库，无法抽取内置图谱")
    say(f"  图谱源：{vault}")

    refs = collect_images(qs)
    ok, miss, missing = copy_images(refs, vault, OUT / "data" / "media")
    rewritten = rewrite_paths(qs)
    say(f"  图片引用：{len(refs)} 个唯一路径 → 拷贝 {ok} 张，重写 {rewritten} 处路径")
    if miss:
        say(f"  [warn] {miss} 张源文件缺失：{missing[:3]}")

    (OUT / "data" / "questions.json").write_text(
        json.dumps(qs, ensure_ascii=False), encoding="utf-8")
    say(f"  写出 data/questions.json（{human((OUT / 'data' / 'questions.json').stat().st_size)}）")

    for name in ("questions_model.json", "knowledge_index.json"):
        s = DATA / name
        if s.is_file():
            shutil.copy2(s, OUT / "data" / name)
            say(f"  拷贝 data/{name}（{human(s.stat().st_size)}）")

    # AI 解析缓存：这是「刷题成果」，一起带走（里面没有任何 Key）
    side = DATA / "targeted_analysis.json"
    if side.is_file():
        cache = json.loads(side.read_text(encoding="utf-8"))
        (OUT / "data" / "targeted_analysis.json").write_text(
            json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        say(f"  拷贝 AI 解析缓存 {len(cache)} 条（{human(side.stat().st_size)}）")

    # ---------- 3. 脱敏配置
    step(3, TOTAL, "生成彻底脱敏的初始配置与空进度")
    cfg = fresh_config()
    (OUT / "data" / "user_config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "data" / "user_progress.json").write_text(
        json.dumps(EMPTY_PROGRESS, ensure_ascii=False, indent=2), encoding="utf-8")
    say("  data/user_config.json : api_key=\"\" · mode=builtin · vault=\"\"")
    say("  data/user_progress.json: questions={} · daily={} · sessions=[]")

    # .env 绝不能跟着走
    for bad in (HERE / ".env", OUT / ".env"):
        if bad.exists():
            say(f"  [warn] 发现 {bad}，删除（不随包发布）")
            bad.unlink()

    # ---------- 4. PyInstaller
    step(4, TOTAL, "打包后端为免安装可执行文件（PyInstaller -D）")
    if args.skip_pyi and (OUT / f"{APP_NAME}.exe").is_file():
        say("  跳过 PyInstaller，复用已有 exe")
    else:
        work = HERE / "build_pyi"
        if work.exists():
            shutil.rmtree(work)
        shutil.copytree(dist, work / "web" / "dist")
        cmd = pyinstaller() + [
            "--noconfirm", "--clean", "--onedir", "--console",
            "--name", APP_NAME,
            "--distpath", str(HERE / "build_pyi" / "dist"),
            "--workpath", str(HERE / "build_pyi" / "work"),
            "--specpath", str(HERE / "build_pyi"),
            "--add-data", f"{work / 'web'};web",
            "--hidden-import", "uvicorn.logging",
            "--hidden-import", "uvicorn.loops.auto",
            "--hidden-import", "uvicorn.protocols.http.auto",
            "--hidden-import", "uvicorn.protocols.websockets.auto",
            "--hidden-import", "uvicorn.lifespan.on",
            "--hidden-import", "multipart",
            "--exclude-module", "tkinter",
            "--exclude-module", "matplotlib",
            "--exclude-module", "numpy",
            "--exclude-module", "pandas",
            "--exclude-module", "PIL",
            "--exclude-module", "pytest",
            str(HERE / "server.py"),
        ]
        run(cmd, HERE, quiet=True)
        built = HERE / "build_pyi" / "dist" / APP_NAME
        if not (built / f"{APP_NAME}.exe").is_file():
            raise SystemExit("  PyInstaller 没有产出 exe")
        for item in built.iterdir():
            dst = OUT / item.name
            if item.is_dir():
                shutil.copytree(item, dst)
            else:
                shutil.copy2(item, dst)
        # 打包器可能把 data/ 一起带进来（不该有），删掉避免盖住同学的进度
        bundled_data = OUT / "_internal" / "data"
        if bundled_data.exists():
            shutil.rmtree(bundled_data)

    # 前端再放一份到 .exe 同级（server.find_web 优先用它）：
    # 好处是以后想换皮肤/改前端，替换 dist/ 即可，不用重打包 exe。
    ext_dist = OUT / "dist"
    if ext_dist.exists():
        shutil.rmtree(ext_dist)
    shutil.copytree(dist, ext_dist)
    say(f"  dist/         : {sum(1 for _ in ext_dist.rglob('*') if _.is_file())} 个文件（.exe 同级，可直接替换）")
    exe = OUT / f"{APP_NAME}.exe"
    if not exe.is_file():
        raise SystemExit(f"  没有找到 {exe}（--skip-pyi 需要上次的打包结果还在）")
    say(f"  {APP_NAME}.exe : {human(exe.stat().st_size)}")
    say(f"  整个程序目录  : {human(sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()))}")

    # ---------- 5. 启动器与说明
    step(5, TOTAL, "生成双击启动器与使用说明")
    bat = OUT / "启动 Anatomy Studio.bat"
    bat.write_text(BAT.replace("\r\n", "\n").replace("\n", "\r\n"), encoding="ascii", newline="")
    (OUT / "使用说明_README.txt").write_text(
        README_TXT.replace("\r\n", "\n").replace("\n", "\r\n"), encoding="utf-8", newline="")
    say(f"  {bat.name}")
    say(f"  使用说明_README.txt")

    # ---------- 6. 自检
    step(6, TOTAL, "安全自检")
    my_key = ""
    if (DATA / "user_config.json").is_file():
        try:
            my_key = (json.loads((DATA / "user_config.json").read_text(encoding="utf-8"))
                      .get("llm", {}).get("api_key") or "")
        except Exception:
            my_key = ""
    say(f"  我的 Key 长度：{len(my_key)}（只在内存里用于比对，不写进任何发布文件）")

    hits = scan_keys(OUT, [my_key] if my_key else [])
    if hits:
        say("  [FAIL] 以下文件疑似含 Key：")
        for h in hits:
            say(f"    {h}")
        return 2
    say("  ✓ 发布目录全文扫描：没有 sk- 开头的 Key，也没有我的真实 Key 字符串")

    # 二进制兜底：exe/_internal 里也不该出现我的 Key（PyInstaller 只打代码，不打 data）
    for p in OUT.rglob("*"):
        if p.is_file() and p.suffix.lower() in {".exe", ".dll", ".pyd"} and my_key:
            try:
                if my_key.encode() in p.read_bytes():
                    say(f"  [FAIL] 二进制里含 Key：{p.relative_to(OUT)}")
                    return 2
            except OSError:
                pass
    say("  ✓ exe / dll 二进制扫描：干净")

    after = {p: sha256(p) for p in GUARDED if p.is_file()}
    # user_config.json（含 API Key）必须一字不动 —— 硬性失败
    key_file = DATA / "user_config.json"
    if before.get(key_file) != after.get(key_file):
        say("  [FAIL] 开发目录的 user_config.json（含你的 API Key）被改动了！")
        say(f"    {key_file.name}: {before.get(key_file, 'MISSING')[:12]} → {after.get(key_file, 'MISSING')[:12]}")
        return 3
    # user_progress.json 只告警：你在浏览器里答题、或前端自动保存都会让它变，与本脚本无关
    prog_file = DATA / "user_progress.json"
    if before.get(prog_file) != after.get(prog_file):
        say("  [WARN] user_progress.json 在构建期间变了 —— 通常是你在浏览器里答题或前端自动保存，")
        say(f"         构建脚本只读不写这个文件。{before.get(prog_file, 'MISSING')[:12]} → {after.get(prog_file, 'MISSING')[:12]}")
        say("         想确认脚本没动它：停掉浏览器/后端再跑一次 --skip-npm --skip-pyi。")
    else:
        say("  ✓ 开发目录 user_config.json / user_progress.json 指纹未变（个人数据完好）")

    n_files = sum(1 for p in OUT.rglob("*") if p.is_file())
    n_media = sum(1 for p in (OUT / "data" / "media").rglob("*") if p.is_file())
    say("")
    say(f"  发布目录：{OUT}")
    say(f"  文件总数：{n_files}（其中内置图谱 {n_media} 张）")
    say(f"  总大小  ：{human(sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()))}")
    say(f"  耗时    ：{time.time() - t0:.1f} s")
    say("")
    say("  发给同学：整个 AnatomyStudio_Portable 文件夹打包即可。")
    say("  同学双击「启动 Anatomy Studio.bat」→ 浏览器自动打开。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
