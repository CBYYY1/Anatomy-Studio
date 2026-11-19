"""Step 2 · FastAPI 后端：题库 / 进度 / Obsidian 图片代理 / 实时重搜 / Callout 写回

设计要点
--------
* 单进程、纯本地（默认只绑 127.0.0.1），除 npm 安装外不依赖任何外部服务。
* 所有对 Obsidian 库的读写都必须过 `safe_join()`：先把用户传来的相对路径
  resolve 成绝对路径，再断言它仍在 VAULT 之内，否则拒绝。这样即使前端
  （或手改的 URL）传 `../../Windows/System32` 也读不到库外文件。
* 进度存 `data/user_progress.json`，写入走「临时文件 + os.replace」，
  避免断电/崩溃时留下半截 JSON 把整个刷题记录弄废。
* `.md` 写回用带 qid 的 HTML 注释做幂等标记，重复点击只会更新次数，
  不会在同一标题下堆出一堆 Callout。
"""
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import analysis as AI
import config as CFG
import updater as UPD

# ---------------------------------------------------------------- 基础路径
#
# 便携版（PyInstaller）三条路径必须分开看：
#   * 可写数据（data/）→ 永远在 .exe 旁边，绝不进 _MEIPASS（进程退出会被删）
#   * 只读资源（前端 dist/）→ 先找 .exe 同级，再找打包进包内的 _MEIPASS
#   * 源码模式 → 就是本文件所在目录


def _exe_dir() -> Path | None:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return None


def _bundle_dir() -> Path:
    """PyInstaller 解包目录（_MEIPASS）；源码模式下等同源码目录。"""
    meipass = getattr(sys, "_MEIPASS", None)
    return Path(meipass) if meipass else Path(__file__).resolve().parent


HERE = _exe_dir() or Path(__file__).resolve().parent
DATA = HERE / "data"                       # 可写：进度、配置、AI 缓存、内置图谱
QUESTIONS = DATA / "questions.json"
QUESTIONS_MODEL = DATA / "questions_model.json"
KNOWLEDGE = DATA / "knowledge_index.json"
PROGRESS = DATA / "user_progress.json"


def find_web() -> Path | None:
    """前端编译产物的位置。打包后优先用 .exe 同级的 dist/（方便同学换皮肤/更新）。"""
    for cand in (HERE / "dist", HERE / "web" / "dist", _bundle_dir() / "web" / "dist"):
        if (cand / "index.html").is_file():
            return cand
    return None


WEB = find_web() or (HERE / "web" / "dist")


def vault():
    """当前生效的 Obsidian 库路径（builtin 模式下为 None）。

    以前这里是模块级常量 `VAULT`，换了库路径必须重启进程；共享版要让同学
    在「设置」里改完立刻生效，所以改成每次现问 config。
    """
    return CFG.vault_path()


def vault_or_400() -> Path:
    v = vault()
    if v is None:
        raise HTTPException(
            409,
            "当前是「内置静态解析模式」，没有连接 Obsidian 库。"
            "请在【设置 → 知识库】里切到本地联动模式并填入库路径。",
        )
    return v


# ---------------------------------------------------------------- 静态资源

app = FastAPI(title="Anatomy Studio", version="2.2")
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def _no_cache_html_and_api(request, call_next):
    """禁止浏览器缓存 index.html 与 API 响应，确保便携版升级或前端重编译后打开即最新界面。"""
    response = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith(".html") or p.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

_cache = {}
_cache_lock = Lock()

# 检查更新的结果缓存：(结果, 时间戳)。GitHub API 未认证限 60 次/小时，
# 前端每次启动都会问一次，所以 60 秒内直接复用，不在本地空转。
_updater_check_cache: tuple[dict, float] = ({}, 0.0)


def load_json(path, default):
    """带 mtime 缓存的读取：题库 8 MB，每请求都 parse 一次太浪费。"""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return default
    key = str(path)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[warn] {path.name} 读取失败：{exc}")
        return default
    with _cache_lock:
        _cache[key] = (mtime, value)
    return value


def questions():
    return load_json(QUESTIONS, [])


def by_id():
    qs = load_json(QUESTIONS, [])
    return {q["id"]: q for q in qs}


# ---------------------------------------------------------------- 选项矩阵回写

_matrix_lock = Lock()


def persist_option_matrix(qid: str, matrix: dict) -> bool:
    """把 AI 生成的选项矩阵永久写回 questions.json（下次秒开，不再花 Token）。

    * 只改这一题的 `obsidian_match.option_matrix`，并打上 `option_matrix_ai: True`，
      前端据此判断「这是 AI 版」，旧版本地脚本生成的杂乱文本会被整体覆盖。
    * 写入走「临时文件 + os.replace」，并且**只在第一次写之前**留一份
      `questions.bak-matrix.json` 兜底，避免每题都复制 8 MB。
    * 写成功后清掉 mtime 缓存，让后续请求立刻读到新文件。
    """
    if not matrix:
        return False
    with _matrix_lock:
        qs = load_json(QUESTIONS, [])
        if not qs:
            return False
        hit = None
        for q in qs:
            if q.get("id") == qid:
                hit = q
                break
        if hit is None:
            return False
        om = dict(hit.get("obsidian_match") or {})
        om["option_matrix"] = {k: v for k, v in matrix.items() if v}
        om["option_matrix_ai"] = True
        hit["obsidian_match"] = om

        backup = QUESTIONS.with_suffix(".bak-matrix.json")
        try:
            if not backup.exists() and QUESTIONS.exists():
                shutil.copy2(QUESTIONS, backup)   # 只在首次留一份原始题库
            tmp = QUESTIONS.with_suffix(".tmp")
            tmp.write_text(json.dumps(qs, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, QUESTIONS)
        except OSError as exc:
            print(f"[warn] 选项矩阵回写失败（{qid}）：{exc}")
            return False
        with _cache_lock:
            _cache.pop(str(QUESTIONS), None)
    return True


# ---------------------------------------------------------------- 路径安全

def safe_join(rel):
    """把库内相对路径安全地解析成绝对路径；越界一律 403。"""
    if not rel:
        raise HTTPException(400, "缺少 path 参数")
    base_path = vault_or_400()
    rel = urllib.parse.unquote(rel).replace("\\", "/").lstrip("/")
    target = (base_path / rel).resolve()
    base = base_path.resolve()
    if target != base and base not in target.parents:
        raise HTTPException(403, "路径越界：只允许访问 Obsidian 库内文件")
    return target


# ---------------------------------------------------------------- 进度存储

_progress_lock = Lock()

EMPTY_PROGRESS = {
    "version": 1,
    "updated": 0,
    "questions": {},     # id -> {seen, correct, error_count, consecutive_correct, starred, last, first_ok, history[]}
    "daily": {},         # yyyy-mm-dd -> {n, ok}
    "sessions": [],      # [{t, n, ok, module, mode}]
}


def read_progress():
    if not PROGRESS.exists():
        return json.loads(json.dumps(EMPTY_PROGRESS))
    try:
        data = json.loads(PROGRESS.read_text(encoding="utf-8"))
    except Exception:
        # 真的坏了就备份一份再从空开始，绝不静默丢数据
        broken = PROGRESS.with_suffix(f".broken-{int(time.time())}.json")
        try:
            PROGRESS.replace(broken)
            print(f"[warn] user_progress.json 损坏，已备份到 {broken.name}")
        except OSError:
            pass
        return json.loads(json.dumps(EMPTY_PROGRESS))
    for k, v in EMPTY_PROGRESS.items():
        data.setdefault(k, v)
    return data


def write_progress(data):
    data["updated"] = int(time.time())
    DATA.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    tmp = PROGRESS.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    for i in range(6):
        try:
            os.replace(tmp, PROGRESS)
            return
        except PermissionError:
            time.sleep(0.05 * (i + 1))
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    PROGRESS.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- 元数据

_GROUP_PREFIX = re.compile(r"^第[一二三四五六七八九十百]+篇\s*")


def chapter_group(q: dict) -> str:
    """题目所属的「大篇」——直接取题库原始章节路径的第二段。

    题库的 chapter_path 形如
      ["人体解剖学", "第一篇 运动系统", "第一章 骨和骨连结", "第一节 骨和骨连结总论"]
    第一段永远是「人体解剖学」这个根，第二段才是篇（运动系统 / 内脏学 / …）。
    只挂在根上的 12 道题（chapter_path 长度 1）归到「人体解剖学」。
    """
    path = (q.get("meta") or {}).get("chapter_path") or []
    if len(path) >= 2:
        return _GROUP_PREFIX.sub("", str(path[1])).strip()
    return "人体解剖学"


@app.get("/api/meta")
def meta():
    qs = questions()
    model = load_json(QUESTIONS_MODEL, [])
    modules, chapters = {}, {}
    groups: dict[str, dict] = {}
    for q in qs:
        modules[q["module"]] = modules.get(q["module"], 0) + 1
        chapters.setdefault(q["chapter"], 0)
        chapters[q["chapter"]] += 1
        g = chapter_group(q)
        bucket = groups.setdefault(g, {"count": 0, "chapters": {}})
        bucket["count"] += 1
        bucket["chapters"][q["chapter"]] = bucket["chapters"].get(q["chapter"], 0) + 1
    return {
        "vault_name": CFG.vault_name(),
        "vault_path": str(vault() or ""),
        "kb_mode": CFG.knowledge_base().get("mode", "builtin"),
        "total": len(qs),
        "model_total": len(model),
        "single": sum(1 for q in qs if q["type"] == "single"),
        "multiple": sum(1 for q in qs if q["type"] == "multiple"),
        "modules": [{"name": k, "count": v} for k, v in sorted(modules.items())],
        "chapters": [{"name": k, "count": v,
                      "group": next((g for g, b in groups.items() if k in b["chapters"]), "")}
                     for k, v in sorted(chapters.items(), key=lambda x: -x[1])],
        # 两级章节树：篇 → 章（章名在不同篇里可能重复，例如「总论」，
        # 所以前端筛选要用 group + chapter 的组合键，不能只看章名）
        "groups": [
            {"name": g, "count": b["count"],
             "chapters": [{"name": c, "count": n}
                          for c, n in sorted(b["chapters"].items(), key=lambda x: -x[1])]}
            for g, b in sorted(groups.items(), key=lambda kv: -kv[1]["count"])
        ],
        "stats": load_json(DATA / "bank_stats.json", {}),
    }


@app.get("/api/questions")
def list_questions(compact: bool = True):
    qs = questions()
    if not compact:
        return qs
    # 列表页只需要这些字段；完整证据（option_matrix / 上下文 / 图片）按需拉。
    # options 必须带上 —— 练习页的题目队列就是这个列表，缺了它就没有选项可点。
    # has_ai 让题库列表能直接显示「有没有靶向解析」，免得每行都去问后端。
    ai_cache = AI.read_cache()
    return [{"id": q["id"], "type": q["type"], "module": q["module"],
             "chapter": q["chapter"], "group": chapter_group(q),
             "stem": q["stem"], "answer": q["answer"],
             "options": q.get("options") or {},
             "keywords": q["keywords"], "negation": q["negation_warning"],
             "has_ai": q["id"] in ai_cache}
            for q in qs]


@app.get("/api/questions/{qid}")
def get_question(qid: str):
    q = by_id().get(qid)
    if not q:
        raise HTTPException(404, f"没有这道题：{qid}")
    # 靶向解析存在 sidecar 里，读的时候合并进来，前端拿到的永远是最新那份
    hit = AI.get_cached(qid)
    if hit:
        om = dict(q.get("obsidian_match") or {})
        om["targeted_analysis"] = {
            "key_point": hit.get("key_point", ""),
            "distractor_analysis": hit.get("distractor_analysis") or {},
            "pitfall_summary": hit.get("pitfall_summary", ""),
            "source": hit.get("source", ""),
            "generated": hit.get("generated", 0),
        }
        # sidecar 里的矩阵比题库新（batch_analyze 走的也是 sidecar），优先用它
        m = hit.get("option_matrix") or {}
        if m:
            om["option_matrix"] = {k: v for k, v in m.items() if v}
            if hit.get("source") == "llm":
                om["option_matrix_ai"] = True
        q = dict(q)
        q["obsidian_match"] = om
    return q


# ---------------------------------------------------------------- AI 靶向解析


def _need(qid):
    q = by_id().get(qid)
    if not q:
        raise HTTPException(404, f"没有这道题：{qid}")
    return q


@app.get("/api/analyze/status")
def analyze_status():
    """前端用它显示「AI 已接入 / 本地推导模式」。"""
    cache = AI.read_cache()
    llm = CFG.llm()
    return {
        "configured": AI.ENV["configured"],
        "provider": llm.get("provider", ""),
        "model": AI.ENV["model"],
        "base": AI.ENV["base"],
        "style": llm.get("style", "rigorous"),
        "trigger_mode": llm.get("trigger_mode", "on_wrong"),
        "cached": len(cache),
        "env_file": (HERE / ".env").exists(),
    }


@app.post("/api/questions/{qid}/analyze")
def analyze_question(qid: str, payload: dict | None = None):
    """生成（或直接返回）某题的靶向解析。

    body 可选 {force: true}：跳过缓存强制重生成。
    返回体里带上 option_matrix（A–E 的 AI 医学剖析），并已永久写回 questions.json。
    """
    q = _need(qid)
    force = bool((payload or {}).get("force"))
    try:
        result, source = AI.analyze_sync(q, force=force)
    except Exception as exc:
        raise HTTPException(502, f"生成靶向解析失败：{exc}") from exc

    matrix = result.get("option_matrix") or {}
    om = q.get("obsidian_match") or {}
    fresh = bool(result.get("option_matrix")) and source == "llm"
    if fresh:
        persist_option_matrix(qid, matrix)          # 只在模型新生成时落盘，缓存命中不重写 8 MB
    elif not matrix:
        matrix = om.get("option_matrix") or {}      # 模型没给矩阵：回退到题库里那份
    elif source != "llm":
        # 本地兜底也可能带矩阵，合并但保留题库里已有的内容
        merged = {**(om.get("option_matrix") or {}), **matrix}
        matrix = merged
    return {"id": qid, "source": source,
            "option_matrix": matrix,
            "option_matrix_ai": bool(matrix) and (
                fresh or bool(om.get("option_matrix_ai"))),
            "analysis": {
                "key_point": result.get("key_point", ""),
                "distractor_analysis": result.get("distractor_analysis") or {},
                "pitfall_summary": result.get("pitfall_summary", ""),
                "source": result.get("source", source),
                "generated": result.get("generated", 0),
            }}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/questions/{qid}/analyze/stream")
async def analyze_stream(qid: str, payload: dict | None = None):
    """流式版：SSE 推 delta，前端做打字机效果。

    命中缓存或未配置 Key 时直接一次性推完（前端不用区分两条路径）。
    """
    q = _need(qid)
    force = bool((payload or {}).get("force"))

    async def gen():
        def pack(res):
            m = res.get("option_matrix") or {}
            return {"key_point": res.get("key_point", ""),
                    "distractor_analysis": res.get("distractor_analysis") or {},
                    "pitfall_summary": res.get("pitfall_summary", ""),
                    "option_matrix": m,
                    "source": res.get("source", ""),
                    "generated": res.get("generated", 0)}

        if not force:
            hit = AI.get_cached(qid)
            if hit:
                yield _sse("meta", {"source": hit.get("source", "cache"), "cached": True})
                yield _sse("final", {"analysis": pack(hit)})
                return

        if not AI.ENV["configured"]:
            local = AI.normalize(AI.local_analysis(q), q)
            AI.put_cached(qid, local, "local")
            yield _sse("meta", {"source": "local", "cached": False})
            # 本地推导没有 token 流，按句子切开发，让前端动画一致
            buf = ""
            for ch in local["key_point"]:
                buf += ch
                if len(buf) >= 14:
                    yield _sse("delta", {"text": buf})
                    buf = ""
            if buf:
                yield _sse("delta", {"text": buf})
            yield _sse("final", {"analysis": pack(local)})
            return

        yield _sse("meta", {"source": "llm", "cached": False})
        parts = []
        try:
            async for piece in AI.chat_stream(AI.build_messages(q)):
                parts.append(piece)
                yield _sse("delta", {"text": piece})
            obj = AI.normalize(AI.parse_json_block("".join(parts)), q)
            if obj.get("option_matrix"):
                persist_option_matrix(qid, obj["option_matrix"])
            AI.put_cached(qid, obj, "llm")
            yield _sse("final", {"analysis": pack(obj)})
        except Exception as exc:
            yield _sse("error", {"message": str(exc)[:400]})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/knowledge")
def knowledge():
    """术语 -> 笔记小节索引，供「概念 → 笔记」跳转。"""
    return load_json(KNOWLEDGE, {})


# ---------------------------------------------------------------- 进度接口

@app.get("/api/progress")
def get_progress():
    with _progress_lock:
        p = read_progress()
    stars = [k for k, v in p["questions"].items() if v.get("starred")]
    return {"progress": p, "starred": stars,
            "counts": {
                "seen": sum(1 for v in p["questions"].values() if v.get("seen")),
                "wrong": sum(1 for v in p["questions"].values() if v.get("error_count")),
                "starred": len(stars),
                "mastered": sum(1 for v in p["questions"].values()
                                if v.get("consecutive_correct", 0) >= 3),
            }}


@app.post("/api/progress/answer")
def record_answer(payload: dict):
    """记一次作答。payload: {id, ok, picked[], mode}"""
    qid = payload.get("id")
    if not qid:
        raise HTTPException(400, "缺少 id")
    ok = bool(payload.get("ok"))
    picked = payload.get("picked") or []
    now = int(time.time())
    day = time.strftime("%Y-%m-%d", time.localtime(now))

    with _progress_lock:
        p = read_progress()
        r = p["questions"].setdefault(qid, {
            "seen": 0, "correct": 0, "error_count": 0,
            "consecutive_correct": 0, "starred": False,
            "last": 0, "first_ok": 0, "history": [],
        })
        r["seen"] += 1
        r["last"] = now
        if ok:
            r["correct"] += 1
            r["consecutive_correct"] += 1
            if not r["first_ok"]:
                r["first_ok"] = now
        else:
            r["error_count"] += 1
            r["consecutive_correct"] = 0
        r["history"].append({"t": now, "ok": ok, "picked": picked})
        r["history"] = r["history"][-12:]

        d = p["daily"].setdefault(day, {"n": 0, "ok": 0})
        d["n"] += 1
        d["ok"] += 1 if ok else 0
        write_progress(p)
        return {"record": r, "day": d}


@app.post("/api/progress/star")
def toggle_star(payload: dict):
    qid = payload.get("id")
    if not qid:
        raise HTTPException(400, "缺少 id")
    with _progress_lock:
        p = read_progress()
        r = p["questions"].setdefault(qid, {
            "seen": 0, "correct": 0, "error_count": 0,
            "consecutive_correct": 0, "starred": False,
            "last": 0, "first_ok": 0, "history": [],
        })
        r["starred"] = not r.get("starred")
        write_progress(p)
        return {"id": qid, "starred": r["starred"]}


@app.post("/api/progress/reset")
def reset_progress():
    with _progress_lock:
        write_progress(json.loads(json.dumps(EMPTY_PROGRESS)))
    return {"ok": True}


@app.post("/api/progress/session")
def save_session(payload: dict):
    with _progress_lock:
        p = read_progress()
        p["sessions"].append({
            "t": int(time.time()),
            "n": int(payload.get("n") or 0),
            "ok": int(payload.get("ok") or 0),
            "module": payload.get("module") or "",
            "mode": payload.get("mode") or "",
        })
        p["sessions"] = p["sessions"][-200:]
        write_progress(p)
    return {"ok": True}


@app.get("/api/cram")
def cram(n: int = Query(0, ge=0, le=10000)):
    """考前智能突击队列。

    Priority = ErrorCount * 2 - ConsecutiveCorrect + (Starred ? 1.5 : 0)
    连续答对 `cram_mastery_streak` 次（默认 3，可在设置里改）视为「暂时掌握」，
    移出急救池（但不会删记录）。
    n=0（默认）表示不截断，返回全部待抢救题目。
    """
    streak_gate = int(CFG.quiz_prefs().get("cram_mastery_streak") or 3)
    qs = {q["id"]: q for q in questions()}
    p = read_progress()
    pool = []
    for qid, r in p["questions"].items():
        if qid not in qs:
            continue
        if r.get("consecutive_correct", 0) >= streak_gate:
            continue
        err = r.get("error_count", 0)
        star = bool(r.get("starred"))
        if err == 0 and not star:
            continue
        pri = err * 2 - r.get("consecutive_correct", 0) + (1.5 if star else 0)
        pool.append({"id": qid, "priority": round(pri, 2), "error_count": err,
                     "consecutive_correct": r.get("consecutive_correct", 0),
                     "starred": star, "last": r.get("last", 0),
                     "chapter": qs[qid]["chapter"], "stem": qs[qid]["stem"]})
    pool.sort(key=lambda x: (-x["priority"], -x["error_count"], -x["last"]))
    items = pool[:n] if n and n > 0 else pool
    return {"n": n or len(pool), "total": len(pool), "streak_gate": streak_gate,
            "items": items}


# ---------------------------------------------------------------- Obsidian 媒体

_MEDIA_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
              ".bmp": "image/bmp"}

# 内置模式下的图片根目录（分发时由 bundle_media.py 从库里拷过来）
MEDIA_DIR = DATA / "media"


def media_roots() -> list[Path]:
    """图片从哪儿读，按优先级：联动了 Obsidian 就先读库，再退回随包发布的 data/media。

    两个都留着是有意义的：同学可能只连了一个不完整的库，此时内置包里那张图还能兜住。
    """
    roots: list[Path] = []
    v = vault()
    if v is not None:
        roots.append(v)
    if MEDIA_DIR.is_dir():
        roots.append(MEDIA_DIR)
    return roots


def media_root() -> Path | None:
    roots = media_roots()
    return roots[0] if roots else None


@app.get("/api/media-source")
def media_source():
    """给前端/排查用：当前到底能从哪儿读到图。"""
    roots = media_roots()
    return {
        "roots": [str(p) for p in roots],
        "bundle": MEDIA_DIR.is_dir(),
        "bundle_files": sum(1 for p in MEDIA_DIR.rglob("*") if p.is_file()) if MEDIA_DIR.is_dir() else 0,
        "kb_mode": CFG.knowledge_base().get("mode", "builtin"),
    }


@app.get("/api/obsidian-media")
def obsidian_media(path: str = Query(...)):
    roots = media_roots()
    if not roots:
        raise HTTPException(404, "没有可用的图片目录（未打包 media，也未连接 Obsidian 库）")
    rel = urllib.parse.unquote(path).replace("\\", "/").lstrip("/")
    if Path(rel).suffix.lower() not in _MEDIA_EXT:
        raise HTTPException(415, "只代理图片附件")

    # 便携版的题库把路径重写成 `media/raw/attachments/...`（以 data/ 为基准描述），
    # 而媒体根目录本身就是 data/media，所以要先剥掉这个前缀再拼。两种写法都试。
    cands = [rel]
    if rel.startswith("media/"):
        cands.append(rel[len("media/"):])

    target = None
    for one in cands:
        for root in roots:
            base = root.resolve()
            cand = (base / one).resolve()
            if cand != base and base not in cand.parents:
                raise HTTPException(403, "路径越界：只允许访问图片目录内文件")
            if cand.is_file():
                target = cand
                break
        if target is not None:
            break
    if target is None:
        raise HTTPException(404, f"图片不存在：{path}")
    return FileResponse(target, media_type=_MEDIA_EXT[target.suffix.lower()],
                        headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/obsidian-note")
def obsidian_note(path: str = Query(...)):
    target = safe_join(path)
    if target.suffix.lower() != ".md":
        raise HTTPException(415, "只读取 .md 笔记")
    if not target.is_file():
        raise HTTPException(404, f"笔记不存在：{path}")
    return {"path": path.replace("\\", "/"), "text": target.read_text(encoding="utf-8")}


@app.get("/api/obsidian-link")
def obsidian_link(path: str = Query(..., description="库内相对路径")):
    """生成 obsidian:// 协议链接，交给前端做「在 Obsidian 中打开」。

    builtin 模式下没有本地库，返回 available=False，前端据此隐藏按钮。
    """
    name = CFG.vault_name()
    if vault() is None:
        return {"url": "", "vault": name, "available": False,
                "reason": "当前是内置静态解析模式，没有可唤起的本地 Obsidian 库"}
    rel = path.replace("\\", "/")
    if rel.lower().endswith(".md"):
        rel = rel[:-3]
    url = ("obsidian://open?vault=" + urllib.parse.quote(name)
           + "&file=" + urllib.parse.quote(rel))
    return {"url": url, "vault": name, "available": True}


# ---------------------------------------------------------------- 实时全文重搜

_MD_CACHE = {"t": 0.0, "docs": [], "root": ""}
_STOP = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9]+")


def vault_docs():
    """扫描全库 md（跳过 .obsidian / .check），60 秒内复用结果。

    缓存按「库根路径」隔离：同学在设置里换了库，旧的扫描结果不能残留。
    """
    root_path = vault_or_400()
    root_key = str(root_path)
    if (time.time() - _MD_CACHE["t"] < 60 and _MD_CACHE["docs"]
            and _MD_CACHE["root"] == root_key):
        return _MD_CACHE["docs"]
    docs = []
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [d for d in dirs if d not in (".obsidian", ".check", ".git")]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = Path(root) / f
            try:
                text = full.read_text(encoding="utf-8")
            except Exception:
                continue
            rel = full.relative_to(root_path).as_posix()
            docs.append({"path": rel, "text": text})
    _MD_CACHE["t"] = time.time()
    _MD_CACHE["docs"] = docs
    _MD_CACHE["root"] = root_key
    return docs


@app.get("/api/search")
def search(q: str = Query(..., min_length=1), limit: int = Query(30, ge=1, le=200)):
    """在 Obsidian 库里实时找含该词的段落（供「重新匹配」按钮用）。"""
    q = q.strip()
    hits = []
    for doc in vault_docs():
        if q not in doc["text"]:
            continue
        # 定位到所在标题
        pos = doc["text"].find(q)
        head = ""
        for m in re.finditer(r"^(#{1,6})\s+(.+)$", doc["text"][:pos], flags=re.M):
            head = m.group(2).strip()
        start = max(0, pos - 120)
        end = min(len(doc["text"]), pos + 220)
        frag = re.sub(r"\s+", " ", doc["text"][start:end]).strip()
        hits.append({"path": doc["path"], "heading": head, "snippet": frag,
                     "score": doc["text"].count(q)})
        if len(hits) >= limit * 4:
            break
    hits.sort(key=lambda x: -x["score"])
    return {"q": q, "count": len(hits), "items": hits[:limit]}


# ---------------------------------------------------------------- Callout 写回

_WRITE_LOCK = Lock()

# 一个 Callout 块 = 标记行 + 紧随其后的所有 `> ` 行。
# 早前写成 `(?:.|\n)*?(?=\n(?:> |...))` —— 惰性量词会在「标记行后的第一个 \n> 」
# 就停下（即只匹配标记行本身），于是每次调用都在旧块旁边再插一个新块，
# 两次调用后就出现了两个重复 Callout。必须显式吃掉整段引用行。
CALLOUT_RE = re.compile(
    r"<!-- anatomy-drill:(?P<qid>[^\s]+) -->[ \t]*\n(?:>[^\n]*\n?)*"
)

# 替换旧块时用的占位符（不会被 markdown 渲染，也不会与正文冲突）
_SLOT = "\x00ANATOMY_CALLOUT_SLOT\x00"


def _callout_block(qid, stem, answer, count, note=""):
    ans = "、".join(answer) if answer else "—"
    return (
        f"<!-- anatomy-drill:{qid} -->\n"
        f"> [!danger] 刷题高频雷区（已累计错 {count} 次）\n"
        f"> - **易错原题**：{stem}\n"
        f"> - **核心避坑**：正确答案 {ans}，注意与干扰项区分！\n"
        + (f"> - **备注**：{note}\n" if note else "")
    )


def _strip_callout(text, qid):
    """把该题的所有既有 Callout 块换成占位符，返回 (新文本, 命中块数)。

    用占位符而不是直接删空，是因为后面还要把新块放回「原来的位置」。
    早前版本先把块删掉、再用原文里算出的下标去插入，结果因为删块带来的
    空白压缩让下标整体偏移，块被插进了 `**参考答案**` 中间（把粗体拆坏）。
    改成字符串占位后就不再依赖下标。
    """
    hits = 0

    def repl(m):
        nonlocal hits
        if m.group("qid") != qid:
            return m.group(0)
        hits += 1
        return _SLOT if hits == 1 else ""

    out = CALLOUT_RE.sub(repl, text)
    return out, hits


def _slot_pos_cleanup(text):
    """收尾：把占位符两侧多余空行压平，避免 markdown 里出现大块空白。"""
    out = re.sub(r"[ \t]+\n", "\n", text)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out


def _atomic_write(target: Path, text: str, tries: int = 6):
    """尽量原子地写笔记。

    Windows 上 `os.replace` 在目标被别的进程（Obsidian 正在索引/预览）打开时
    会抛 PermissionError[WinError 5]。这里先重试几次（多数锁是瞬时的），
    仍失败就退回「直接覆盖写」——普通文本写通常还能成功；
    再失败才把锁冲突如实报给前端，而不是伪装成 500。
    """
    tmp = target.with_suffix(target.suffix + ".anatomy-tmp")
    tmp.write_text(text, encoding="utf-8")
    last = None
    for i in range(tries):
        try:
            os.replace(tmp, target)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.12 * (i + 1))
    # 退回非原子写
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        with open(target, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        return
    except PermissionError:
        raise HTTPException(
            409,
            "笔记正被 Obsidian 占用（文件锁）。请在 Obsidian 里关闭这篇笔记后重试。",
        ) from last


@app.post("/api/mark-error")
def mark_error(payload: dict):
    """把高频错题以 Obsidian Callout 写回对应笔记的匹配标题下（幂等）。"""
    qid = payload.get("id")
    if not qid:
        raise HTTPException(400, "缺少 id")
    kb = CFG.knowledge_base()
    if kb.get("mode") != "obsidian":
        raise HTTPException(409, "当前是内置静态解析模式，不会改动本地笔记。"
                                 "如需写回，请在【设置 → 知识库】切到本地联动模式。")
    if not kb.get("enable_writeback"):
        raise HTTPException(409, "写回功能已在设置里关闭。")
    q = by_id().get(qid)
    if not q:
        raise HTTPException(404, f"没有这道题：{qid}")
    om = q.get("obsidian_match") or {}
    rel = om.get("matched_note") or ""
    if not rel:
        raise HTTPException(400, "这道题没有关联笔记，无法写回")
    target = safe_join(rel)
    if not target.is_file():
        raise HTTPException(404, f"笔记不存在：{rel}")

    p = read_progress()
    count = (p["questions"].get(qid) or {}).get("error_count", 0) or 1
    threshold = int(kb.get("writeback_threshold") or 3)
    if count < threshold and not payload.get("force"):
        raise HTTPException(409, f"这道题目前错了 {count} 次，还没到设置里的阈值 {threshold} 次。")

    with _WRITE_LOCK:
        text = target.read_text(encoding="utf-8")
        block = _callout_block(qid, q["stem"], q["answer"], count,
                              payload.get("note", ""))

        # 先把这道题的旧块（含历史重复块）换成占位符，再决定放回哪里。
        stripped, hits = _strip_callout(text, qid)
        if hits:
            # 已有记录 → 原位换新块，位置完全由占位符决定
            text = stripped.replace(_SLOT, block, 1)
            action = "updated"
        else:
            heading = (om.get("heading") or "").strip()
            insert_at = -1
            if heading:
                # 找到与该标题文本一致的 ATX 标题行，插到它后面
                for m in re.finditer(r"^(#{1,6})\s+(.+?)\s*$", stripped, flags=re.M):
                    if m.group(2).strip() == heading:
                        line_end = stripped.find("\n", m.end())
                        insert_at = len(stripped) if line_end < 0 else line_end + 1
                        break
            if insert_at < 0:
                insert_at = len(stripped.rstrip()) + 1
                block = "\n" + block
            # 块前后各留一空行，避免和相邻的 **粗体** 段落粘连
            text = stripped[:insert_at] + "\n" + block + "\n" + stripped[insert_at:]
            action = "inserted"

        if _SLOT in text:  # 兜底：绝不把占位符写进用户笔记
            text = text.replace(_SLOT, "")
        text = _slot_pos_cleanup(text)

        # 原子写：临时文件 + replace（失败时自动降级，见 _atomic_write）
        _atomic_write(target, text)

    return {"ok": True, "action": action, "note": rel, "count": count,
            "vault": CFG.vault_name()}


# ---------------------------------------------------------------- 设置中心

@app.get("/api/settings")
def get_settings(reveal: bool = False):
    """读用户配置。

    `reveal=false`（默认）时 api_key 是 `sk-••••1234`；只有前端点了「小眼睛」
    才会带 `?reveal=1` 来取明文 —— 明文只在本地回环上传输。
    """
    cfg = CFG.load()
    if reveal:
        out = json.loads(json.dumps(cfg))
        out["_providers"] = CFG.PROVIDERS
        out["_vault_name"] = CFG.vault_name()
        out["_vault_effective"] = str(vault() or "")
        out["llm"]["configured"] = bool((cfg["llm"].get("api_key") or "").strip())
        out["llm"]["api_key_raw"] = True
        return out
    return CFG.public(cfg)


@app.put("/api/settings")
def put_settings(payload: dict):
    """保存配置。传上来的脱敏 Key（含 •）会被忽略，避免把掩码存回去。"""
    patch = json.loads(json.dumps(payload or {}))
    llm_patch = patch.get("llm") or {}
    key = (llm_patch.get("api_key") or "").strip()
    if "•" in key or key == "":
        # 前端没改 Key（保持原值）——别把它清空，也别把掩码写进文件
        llm_patch.pop("api_key", None)
        if not key:
            llm_patch.pop("api_key", None)
    patch["llm"] = llm_patch
    try:
        cfg = CFG.update(patch)
    except Exception as exc:
        raise HTTPException(400, f"配置保存失败：{exc}") from exc
    # 库路径变了就把扫描缓存废掉
    _MD_CACHE["t"] = 0.0
    _MD_CACHE["docs"] = []
    _MD_CACHE["root"] = ""
    return CFG.public(cfg)


@app.post("/api/settings/test-llm")
def test_llm(payload: dict | None = None):
    """极简连通性测试：发一句 "Reply with OK"，返回耗时与错误详情。"""
    body = payload or {}
    llm = CFG.llm()
    base = (body.get("base_url") or llm.get("base_url") or "").strip().rstrip("/")
    key = (body.get("api_key") or "").strip()
    if not key or "•" in key:
        key = (llm.get("api_key") or "").strip()
    model = (body.get("model") or llm.get("model") or "").strip()
    provider = body.get("provider") or llm.get("provider") or "custom"
    if not base:
        raise HTTPException(400, "先填 Base URL")
    if not model:
        raise HTTPException(400, "先填模型名称")
    if not key and provider != "ollama":
        raise HTTPException(400, "先填 API Key（本地 Ollama 可留空）")

    import httpx
    t0 = time.perf_counter()
    try:
        with httpx.Client(**AI.client_kwargs(base, 30)) as cli:
            r = cli.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {key}",
                         "Content-Type": "application/json"},
                json={"model": model, "max_tokens": 8, "temperature": 0,
                      "messages": [{"role": "user",
                                    "content": "Reply with exactly: OK"}]},
            )
    except Exception as exc:
        return {"ok": False, "ms": int((time.perf_counter() - t0) * 1000),
                "detail": f"连不上：{type(exc).__name__}: {exc}"[:400]}
    ms = int((time.perf_counter() - t0) * 1000)
    if r.status_code >= 400:
        try:
            detail = r.json().get("error", {}).get("message") or r.text[:300]
        except Exception:
            detail = r.text[:300]
        hint = ""
        if r.status_code == 401:
            hint = "（Key 无效或已过期）"
        elif r.status_code == 402 or "balance" in str(detail).lower():
            hint = "（账户余额不足）"
        elif r.status_code == 404:
            hint = "（Base URL 或模型名不对）"
        elif r.status_code == 429:
            hint = "（触发限流，稍再试）"
        return {"ok": False, "ms": ms, "status": r.status_code,
                "detail": f"{detail}{hint}"[:400]}
    try:
        reply = r.json()["choices"][0]["message"]["content"]
    except Exception:
        reply = ""
    return {"ok": True, "ms": ms, "status": r.status_code,
            "model": model, "reply": str(reply)[:60]}


@app.post("/api/settings/fetch-models")
def fetch_models(payload: dict | None = None):
    """实时拉取该平台当前在线的模型列表（OpenAI 兼容 /models）。

    不写死任何模型名：平台上了新模型，点一下同步就能看到。
    失败时返回 ok:false + 人话原因，前端自动回退到内置预设。
    """
    body = payload or {}
    llm = CFG.llm()
    base = (body.get("base_url") or llm.get("base_url") or "").strip().rstrip("/")
    key = (body.get("api_key") or "").strip()
    if not key or "•" in key:
        key = (llm.get("api_key") or "").strip()
    provider = (body.get("provider") or llm.get("provider") or "custom")
    if not base:
        raise HTTPException(400, "先填 Base URL")
    if not key and provider != "ollama":
        raise HTTPException(400, "先填 API Key（本地 Ollama 可留空）")

    # 候选地址：标准 OpenAI 兼容 /models；Ollama 再兼容原生 /api/tags
    cands = [f"{base}/models"]
    if base.lower().endswith("/v1"):
        cands.append(f"{base[:-3]}/api/tags")
    else:
        cands.append(f"{base}/v1/models")
    if "11434" in base or provider == "ollama":
        cands.append(f"{base.replace('/v1', '')}/api/tags")

    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    import httpx
    errors: list[str] = []
    seen: set[str] = set()
    ordered = [u for u in cands if not (u in seen or seen.add(u))]

    for url in ordered:
        try:
            with httpx.Client(follow_redirects=True,
                              **AI.client_kwargs(base, 8)) as cli:
                r = cli.get(url, headers=headers)
        except Exception as exc:
            errors.append(f"{url} → {type(exc).__name__}: {exc}"[:200])
            continue
        if r.status_code >= 400:
            hint = {401: "Key 无效或已过期", 403: "没有权限",
                    404: "该平台不支持 /models 接口"}.get(r.status_code, "")
            errors.append(f"{url} → HTTP {r.status_code}"
                          + (f"（{hint}）" if hint else ""))
            continue
        try:
            data = r.json()
        except Exception:
            errors.append(f"{url} → 返回的不是 JSON")
            continue

        ids: list[str] = []
        if isinstance(data, dict):
            rows = data.get("data") or data.get("models") or []
        elif isinstance(data, list):
            rows = data
        else:
            rows = []
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict):
                mid = row.get("id") or row.get("name") or row.get("model")
            else:
                mid = row
            mid = str(mid or "").strip()
            if mid and len(mid) <= 200:
                ids.append(mid)
        ids = sorted(dict.fromkeys(ids), key=lambda s: s.lower())
        if not ids:
            errors.append(f"{url} → 接口通了但没解析出模型 id")
            continue

        CFG.remember_models(base, ids)
        return {"ok": True, "models": ids, "count": len(ids),
                "source": url, "base_url": base}

    return {"ok": False, "models": [], "count": 0,
            "detail": "；".join(errors)[:600] or "拉取失败",
            "hint": "可以继续手填模型名，不影响使用"}


@app.post("/api/settings/pin-model")
def pin_model(payload: dict | None = None):
    """把某个模型钉成常用胶囊（或取消钉住）。前端「胶囊管理」用。"""
    body = payload or {}
    model = (body.get("model") or "").strip()
    if not model:
        raise HTTPException(400, "缺少 model")
    pinned = list(CFG.llm().get("pinned") or [])
    want = bool(body.get("pinned", True))
    if want and model not in pinned:
        if len(pinned) >= 40:
            raise HTTPException(400, "常用胶囊最多 40 个，先删几个")
        pinned.append(model)
    elif not want:
        pinned = [m for m in pinned if m != model]
    cfg = CFG.update({"llm": {"pinned": pinned}})
    return {"ok": True, "pinned": cfg["llm"].get("pinned") or []}


@app.post("/api/settings/verify-obsidian")
def verify_obsidian(payload: dict | None = None):
    """验证库路径存在、能读到 .md，返回笔记数与建议的库名。"""
    body = payload or {}
    p = (body.get("path") or "").strip()
    if not p:
        raise HTTPException(400, "先填 Obsidian 库路径")
    path = Path(p).expanduser()
    if not path.is_dir():
        return {"ok": False, "detail": f"这个路径不是文件夹：{p}"}
    md = images = 0
    try:
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in (".obsidian", ".check", ".git", ".trash")]
            for f in files:
                low = f.lower()
                if low.endswith(".md"):
                    md += 1
                elif low.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")):
                    images += 1
            if md > 50000:
                break
    except Exception as exc:
        return {"ok": False, "detail": f"扫描失败：{exc}"}
    if md == 0:
        return {"ok": False, "detail": "文件夹里没有找到 .md 笔记，确认选的是 Obsidian 库根目录",
                "notes": 0, "images": images}
    name = path.name
    app_json = path / ".obsidian" / "app.json"
    if app_json.is_file():
        try:
            name = json.loads(app_json.read_text(encoding="utf-8")).get("vaultName") or name
        except Exception:
            pass
    return {"ok": True, "notes": md, "images": images,
            "vault_name": name, "path": str(path)}


# ---------------------------------------------------------------- 数据备份

@app.get("/api/data/export-progress")
def export_progress():
    """导出个人学习档案（可直接分享/换电脑恢复）。"""
    p = read_progress()
    blob = json.dumps(p, ensure_ascii=False, indent=1).encode("utf-8")
    stamp = time.strftime("%Y%m%d-%H%M", time.localtime())
    return StreamingResponse(
        io.BytesIO(blob),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="anatomy-progress-{stamp}.json"'},
    )


@app.post("/api/data/import-progress")
async def import_progress(file: UploadFile = File(...)):
    """导入做题进度。只认 questions/daily/sessions 三个键，其余忽略。"""
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except Exception as exc:
        raise HTTPException(400, f"这不是合法的 JSON 备份：{exc}") from exc
    if not isinstance(data, dict) or "questions" not in data:
        raise HTTPException(400, "备份格式不对：缺少 questions 字段")
    merged = json.loads(json.dumps(EMPTY_PROGRESS))
    known = {q["id"] for q in questions()}
    kept = dropped = 0
    for qid, rec in (data.get("questions") or {}).items():
        if qid not in known:
            dropped += 1          # 旧题库里已删除的题，跳过而不是报错
            continue
        merged["questions"][qid] = rec
        kept += 1
    merged["daily"] = data.get("daily") or {}
    merged["sessions"] = (data.get("sessions") or [])[-200:]
    with _progress_lock:
        # 导入前先备份当前进度，误操作还能捞回来
        if PROGRESS.exists():
            PROGRESS.replace(PROGRESS.with_suffix(
                f".bak-{time.strftime('%Y%m%d-%H%M%S')}.json"))
        write_progress(merged)
    return {"ok": True, "imported": kept, "skipped": dropped,
            "seen": sum(1 for v in merged["questions"].values() if v.get("seen"))}


@app.post("/api/data/update-question-bank")
async def update_question_bank(file: UploadFile = File(...)):
    """热更新题库：只替换题目与解析，绝不动 user_progress.json。"""
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except Exception as exc:
        raise HTTPException(400, f"这不是合法的 JSON 题库：{exc}") from exc
    if not isinstance(data, list) or not data:
        raise HTTPException(400, "题库格式不对：应为非空的 JSON 数组")
    sample = data[0]
    for field in ("id", "stem", "options", "answer"):
        if field not in sample:
            raise HTTPException(400, f"题库格式不对：题目缺少 {field} 字段")

    backup = QUESTIONS.with_suffix(f".bak-{time.strftime('%Y%m%d-%H%M%S')}.json")
    if QUESTIONS.exists():
        QUESTIONS.replace(backup)
    tmp = QUESTIONS.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, QUESTIONS)
    with _cache_lock:
        _cache.pop(str(QUESTIONS), None)

    # 题库换了，进度里的题号可能对不上：统计一下但不删
    known = {q["id"] for q in questions()}
    p = read_progress()
    orphan = [k for k in p["questions"] if k not in known]
    return {"ok": True, "total": len(data), "orphan": len(orphan),
            "backup": backup.name,
            "note": "个人错题与收藏已完整保留；题库里已删除的题会暂时留档，不会被清空。"}


@app.post("/api/data/reset-progress")
def reset_progress_api(payload: dict | None = None):
    """清空做题记录。需 confirm=true，防止误点。"""
    body = payload or {}
    if not body.get("confirm"):
        raise HTTPException(400, "需要 confirm=true 才执行")
    scope = (body.get("scope") or "all").strip()
    with _progress_lock:
        p = read_progress()
        if scope == "wrong":
            for qid, rec in list(p["questions"].items()):
                rec["error_count"] = 0
                rec["consecutive_correct"] = 0
                rec["history"] = []
            kept = len(p["questions"])
            write_progress(p)
            return {"ok": True, "scope": "wrong", "kept": kept}
        write_progress(json.loads(json.dumps(EMPTY_PROGRESS)))
    return {"ok": True, "scope": "all"}


@app.post("/api/settings/clear-key")
def clear_key(payload: dict | None = None):
    if not (payload or {}).get("confirm"):
        raise HTTPException(400, "需要 confirm=true 才执行")
    cfg = CFG.load()
    cfg["llm"]["api_key"] = ""
    CFG.save(cfg)
    return {"ok": True}


# ---------------------------------------------------------------- 云端热同步

@app.get("/api/updater/meta")
def updater_meta():
    """版本与仓库信息（前端胶囊初始化用，不联网）。"""
    upd = CFG.updater()
    local = UPD.local_manifest()
    return {
        "app_version": CFG.APP_VERSION,
        "repo": CFG.repo(),
        "branch": upd.get("branch") or "main",
        "last_sync_at": int(upd.get("last_sync_at") or 0),
        "last_sync_commit": upd.get("last_sync_commit") or "",
        "last_bank_version": (upd.get("last_bank_version")
                              or local.get("bank_version") or ""),
        "bank_version": local.get("bank_version") or "",
        "bank_updated_at": local.get("bank_updated_at") or "",
        "bank_changelog": local.get("bank_changelog") or "",
        "bank_stats": local.get("stats") or {},
        "auto_check": bool(upd.get("auto_check", True)),
        "notify": bool(upd.get("notify", True)),
        "releases_url": (f"https://github.com/{CFG.repo()}/releases"
                         if CFG.repo() else ""),
        "questions_mtime": (QUESTIONS.stat().st_mtime
                            if QUESTIONS.is_file() else 0),
        "questions_count": len(questions()),
    }


@app.get("/api/updater/check")
def updater_check(fresh: bool = False):
    """对比 GitHub 上的 Release 与题库 commit。网络失败不抛错，回 ok=false。"""
    global _updater_check_cache
    now = time.time()
    if not fresh and _updater_check_cache[1] and now - _updater_check_cache[1] < 60:
        return _updater_check_cache[0]          # 60 秒内不重复打 GitHub API
    res = UPD.check()
    if res.get("ok"):
        _updater_check_cache = (res, now)
    return res


@app.get("/api/updater/status")
def updater_status():
    """同步进度（前端进度条轮询）。"""
    return UPD.state()


@app.post("/api/updater/sync-bank")
def updater_sync_bank(payload: dict | None = None):
    """一键热更新题库与配图。绝不触碰 user_progress.json / user_config.json 的
    llm 与 knowledge_base 段。"""
    global _updater_check_cache
    body = payload or {}
    if body.get("check_only"):
        return UPD.check()
    res = UPD.sync_bank()
    _updater_check_cache = ({}, 0.0)
    return res


@app.get("/api/updater/app-update-status")
def updater_app_update_status():
    """应用程序本体自动更新进度查询（前端轮询）。"""
    return UPD.app_update_state()


@app.post("/api/updater/apply-app-update")
def updater_apply_app_update(payload: dict | None = None):
    """一键自动更新应用程序本体（便携版下载解压热替换重启 / 源码版 git pull）。"""
    global _updater_check_cache
    _updater_check_cache = ({}, 0.0)
    return UPD.start_app_update(payload or {})


# ---------------------------------------------------------------- 前端静态文件

if (WEB / "index.html").is_file():
    app.mount("/", StaticFiles(directory=str(WEB), html=True), name="web")
else:
    @app.get("/")
    def no_web():
        return JSONResponse({
            "ok": False,
            "message": "前端还没构建。请在 studio/web 下执行 npm install && npm run build",
        })


# ---------------------------------------------------------------- 启动

def _free_port(host: str, start: int, tries: int = 30) -> int:
    """从 start 开始找一个能绑上的端口（同学机器上 8788 可能被别的程序占了）。"""
    import socket
    bind_host = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((bind_host, p))
                return p
            except OSError:
                continue
    return start


def _bootstrap_examples() -> list[str]:
    """克隆源码/首次运行时，用 .example.json 铺好可写文件，保证开箱即用。

    只补「缺失」的文件，已经存在的一律不覆盖 —— 用户的 Key 与刷题记录最要紧。
    """
    made = []
    pairs = [
        (DATA / "user_config.example.json", CFG.CONFIG_PATH, "个人配置"),
        (DATA / "user_progress.example.json", PROGRESS, "答题进度"),
    ]
    for src, dst, label in pairs:
        if dst.exists() or not src.is_file():
            continue
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            made.append(label)
        except OSError as exc:
            print(f"[warn] {label}初始化失败：{exc}")
    if made:
        CFG.touch_mtime()          # 让 config 的 mtime 缓存失效
        print(f"  已初始化      : {'、'.join(made)}（来自 .example.json）")
    return made


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    _bootstrap_examples()

    frozen = getattr(sys, "frozen", False)
    srv = CFG.server()
    host = srv["host"]
    port = int(srv["port"]) or (18080 if frozen else 8788)
    if frozen or os.environ.get("ANATOMY_FIND_PORT"):
        port = _free_port(host, port)          # 端口占用就顺延，不让同学看报错
    url = f"http://{host}:{port}/"
    kb = CFG.knowledge_base()
    v = vault()
    llm = CFG.llm()
    print("=" * 58)
    print("  Anatomy Studio · 人体结构学智能刷题与薄弱点分析")
    print("=" * 58)
    print(f"  题库        : {len(questions())} 题")
    if kb.get("mode") == "obsidian" and v:
        print(f"  Obsidian 库 : {v}")
    else:
        print("  知识库模式  : 内置静态解析（无需 Obsidian）")
    n_media = sum(1 for p in MEDIA_DIR.rglob("*") if p.is_file()) if MEDIA_DIR.is_dir() else 0
    print(f"  内置图谱    : {MEDIA_DIR}（{n_media} 张）")
    if AI.ENV["configured"]:
        print(f"  大模型      : {llm.get('provider')} · {AI.ENV['model']}")
    else:
        print("  大模型      : 未配置（不填 Key 也能用内置笔记解析）")
    print(f"  数据目录    : {DATA}")
    print(f"  访问地址    : {url}")
    print("-" * 58)
    print("  Anatomy Studio 正在运行中，请勿关闭此窗口。")
    print("  浏览器已自动打开；若没弹出来，手动复制上面那行地址。")
    print("  关闭窗口或按 Ctrl+C 即停止服务。", flush=True)
    print("=" * 58, flush=True)

    if not os.environ.get("ANATOMY_NO_BROWSER"):
        import threading
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    import uvicorn
    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    except OSError:
        # 极端情况：选中的端口在 bind 前被抢走，退一个端口再来一次
        port = _free_port(host, port + 1)
        print(f"  端口被占用，改用 {port}", flush=True)
        webbrowser.open(f"http://{host}:{port}/")
        uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
