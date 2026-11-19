"""GitHub 云端题库 / 笔记热同步

设计要点
--------
* **不依赖客户端重装**：题库（`data/questions.json`）与配图（`data/media/`）
  都随仓库走，用户点一下就能拉到最新的章节笔记映射与新解析。
* **绝不碰个人数据**：只写 `data/questions.json` 与 `data/media/`，
  `user_progress.json`（错题记录）与 `user_config.json`（API Key）一概不读不写。
* **国内可达性**：`raw.githubusercontent.com` 在校园网经常超时，所以下载走
  「直连 → ghproxy → gh-proxy」的候选链，任一成功即用。
* **增量配图**：远端题库里引用的图片如果本地 `data/media/` 没有，才逐张下载，
  第二次同步基本零流量。
* **保留本地 AI 成果**：同步前把本地已生成的 `targeted_analysis` / AI 版
  `option_matrix` 记下来，远端为空时补回去 —— 用户自己花钱生成的解析不能丢。
"""
from __future__ import annotations

import calendar
import json
import os
import shutil
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from urllib.parse import quote

import config as CFG

TIMEOUT = 12           # 单个请求超时（秒）
MANIFEST_TIMEOUT = 6   # 版本清单只有几百字节，第一轮 6 秒还不回来就换一轮
MEDIA_TIMEOUT = 20     # 图片稍大，给宽一点

# 版本清单：随仓库提交，一次 GET 就能拿到「客户端版本 + 题库版本 + 更新说明」，
# 不用碰 api.github.com（未登录每小时只有 60 次，校园网还常超时）。
VERSION_REL = "data/version.json"

# 下载候选链：直连优先，失败再套代理前缀
_PROXIES = ("https://mirror.ghproxy.com/", "https://ghp.ci/")

_SYSTEM = object()     # _get() 的 proxy 哨兵值：走系统/环境代理（默认行为）

_LOCK = Lock()
_STATE = {
    "running": False,
    "phase": "",          # fetch | bank | media | merge | done | error
    "done": 0,
    "total": 0,
    "message": "",
    "started": 0.0,
    "finished": 0.0,
    "result": None,
}


# ---------------------------------------------------------------- 基础工具


def _ua() -> str:
    return f"AnatomyStudio/{CFG.APP_VERSION} (+https://github.com/{CFG.repo()})"


def _get(url: str, timeout: int = TIMEOUT, headers: dict | None = None,
         proxy=_SYSTEM) -> bytes:
    """发一个 GET。`proxy` 决定这一发走不走代理。

    - `_SYSTEM`（默认）：用 urllib 全局 opener，也就是环境变量 / 系统代理
    - `None`：显式**不走**代理（ProxyHandler({})）
    - 字符串：显式走这个代理地址

    为什么要区分：实测同一台机器上，同一个 raw 地址「走系统代理」稳定 0.4s，
    而「直连」冷启动会卡到 40s 以上（TCP 通、TLS 握手抖），但 api.github.com
    恰好反过来是直连快。所以固定用哪一种都不对，两个都得试。
    """
    req = urllib.request.Request(url, headers={"User-Agent": _ua(),
                                               "Accept": "*/*",
                                               **(headers or {})})
    if proxy is _SYSTEM:
        opener = urllib.request.urlopen
    else:
        handlers = [urllib.request.ProxyHandler(
            {"http": proxy, "https": proxy} if proxy else {})]
        opener = urllib.request.build_opener(*handlers).open
    with opener(req, timeout=timeout) as r:
        return r.read()


def _get_json(url: str, timeout: int = TIMEOUT) -> dict | list:
    raw = _get(url, timeout, {"Accept": "application/vnd.github+json"})
    return json.loads(raw.decode("utf-8"))


def _raw_candidates(rel: str) -> list[str]:
    """给定仓库内相对路径，返回候选地址列表。

    每一项是 `(url, proxy)`：同一个 raw 地址会同时给出「走系统代理」和
    「直连」两种取法，外加各镜像站的直连版本。实测两者的快慢在同一台
    机器上会翻转（raw 走代理 0.4s / 直连 40s+，api 反过来直连 0.4s），
    所以不预设哪个快，交给并发去抢。
    """
    repo = CFG.repo()
    if not repo:
        return []
    branch = CFG.updater().get("branch") or "main"
    path = quote(rel, safe="/")
    direct = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
    cands = [(direct, _SYSTEM), (direct, None)]
    cands += [(f"{p}{direct}", _SYSTEM) for p in _PROXIES]
    return cands


def _fetch_first(rel: str, timeout: int = TIMEOUT) -> tuple[bytes, str]:
    """按候选链依次尝试；返回 (内容, 实际 URL)。全失败抛最后一个错误。

    404 直接跳出：文件在仓库里就不存在，换镜像也拉不到，没必要再等超时。
    """
    errors = []
    for url, proxy in _raw_candidates(rel):
        try:
            return _get(url, timeout, proxy=proxy), url
        except urllib.error.HTTPError as exc:
            errors.append(f"{url.split('/')[2]}: HTTP {exc.code}")
            if exc.code == 404:
                break
        except Exception as exc:                      # noqa: BLE001 — 逐个兜底
            errors.append(f"{url.split('/')[2]}: {type(exc).__name__}")
        continue
    raise RuntimeError("所有下载地址都失败了（" + "；".join(errors) + "）")


def _fetch_any(rel: str, timeout: int = TIMEOUT,
               rounds: int = 1) -> tuple[bytes, str]:
    """同一份文件的多个候选地址**并发**去抢，谁先回来用谁。

    为什么不用串行：校园网下直连常常是「一直等到超时」而不是快速失败，
    串行时 直连 10s + 镜像 20s ≈ 30s，用户会以为软件卡死。

    为什么还要 deadline：`as_completed` 不带超时会等最慢的那个 future，
    而 urllib 的 timeout 是「单次 socket 操作」超时，走代理时实际总耗时可能
    远超它（实测 timeout=10 的代理请求能拖到 20s）。所以这里给整批一个
    硬截止时间，到点就放弃。

    为什么还要 `rounds`：TLS 握手偶尔会整体抖一次（实测首轮 8 个地址全挂、
    紧接着第二轮 0.4s 全通），多跑一轮的成本远低于让用户看到「检查失败」。
    """
    cands = _raw_candidates(rel)
    if not cands:
        raise RuntimeError("没有配置 GitHub 仓库")
    errors: list[str] = []
    for rnd in range(max(1, rounds)):
        pool = ThreadPoolExecutor(max_workers=len(cands))
        try:
            futs = {pool.submit(_get, u, timeout, None, px): (u, px)
                    for u, px in cands}
            try:
                for fut in as_completed(futs, timeout=timeout):
                    url, px = futs[fut]
                    try:
                        return fut.result(), url
                    except Exception as exc:          # noqa: BLE001
                        code = getattr(exc, "code", "")
                        tag = "直连" if px is None else "代理"
                        errors.append(f"{url.split('/')[2]}·{tag}: "
                                      f"{'HTTP ' + str(code) if code else type(exc).__name__}")
            except TimeoutError:
                errors.append(f"第 {rnd + 1} 轮超过 {timeout}s 没有可用地址")
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    raise RuntimeError("所有下载地址都失败了（" + "；".join(errors[-6:]) + "）")


def _ver_tuple(text: str) -> tuple:
    """把 v2.1.0 / 2.1 / 2.1.0-beta 这类 tag 变成可比较的元组。"""
    t = (text or "").strip().lstrip("vV").split("-")[0]
    out = []
    for piece in t.split(".")[:4]:
        digits = "".join(c for c in piece if c.isdigit())
        out.append(int(digits) if digits else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def _images_of(qs: list) -> list[str]:
    seen, out = set(), []
    for q in qs or []:
        for p in (q.get("obsidian_match") or {}).get("images") or []:
            p = str(p or "").strip().replace("\\", "/")
            if p and p not in seen:
                seen.add(p)
                out.append(p)
    return out


# ---------------------------------------------------------------- 版本清单

_MANIFEST_DEFAULT = {
    "app_version": "", "app_release_notes": "", "release_url": "",
    "bank_version": "", "bank_updated_at": "", "bank_changelog": "",
    "stats": {},
}


def local_manifest() -> dict:
    """读随包发布的 data/version.json；缺失时用题库真实情况兜一个。"""
    data = _read_json(CFG.DATA / "version.json", None)
    if not isinstance(data, dict) or not data:
        data = {}
    out = dict(_MANIFEST_DEFAULT)
    out.update({k: v for k, v in data.items() if k in _MANIFEST_DEFAULT})
    try:
        bank = _read_json(CFG.DATA / "questions.json", [])
        stats = dict(out.get("stats") or {})
        stats.setdefault("total_questions", len(bank) if isinstance(bank, list) else 0)
        stats.setdefault("media_count", len(_images_of(bank)) if isinstance(bank, list) else 0)
        out["stats"] = stats
        if not out.get("bank_updated_at"):
            try:
                out["bank_updated_at"] = time.strftime(
                    "%Y-%m-%d %H:%M:%S",
                    time.localtime((CFG.DATA / "questions.json").stat().st_mtime))
            except OSError:
                pass
    except Exception:                                  # noqa: BLE001
        pass
    out["app_version"] = out.get("app_version") or CFG.APP_VERSION
    return out


def fetch_manifest() -> tuple[dict | None, str]:
    """从仓库拉 data/version.json（走 raw + 代理链）。失败返回 (None, 原因)。"""
    try:
        raw, url = _fetch_any(VERSION_REL, timeout=MANIFEST_TIMEOUT, rounds=2)
    except Exception as exc:                           # noqa: BLE001
        return None, str(exc)[:160]
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as exc:                           # noqa: BLE001
        return None, f"version.json 不是合法 JSON（{exc}）"
    if not isinstance(data, dict) or not data:
        return None, "version.json 内容为空"
    out = dict(_MANIFEST_DEFAULT)
    out.update({k: v for k, v in data.items() if k in _MANIFEST_DEFAULT})
    return out, url


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:                                  # noqa: BLE001
        return default


def _write_json_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _set(**kw) -> None:
    with _LOCK:
        _STATE.update(kw)


def state() -> dict:
    with _LOCK:
        return dict(_STATE)


# ---------------------------------------------------------------- 检查更新


def check() -> dict:
    """检查远端有没有新题库 / 新版客户端。

    优先读仓库里的 `data/version.json`（一次 raw GET，绕过 api.github.com 的
    60 次/小时限流，校园网也更稳）；拿不到再退回 GitHub API（Release + commit）。
    """
    repo = CFG.repo()
    if not repo:
        return {"ok": False, "configured": False,
                "detail": "没有配置 GitHub 仓库（设置 → 数据与备份 → 云端仓库）",
                "app_version": CFG.APP_VERSION,
                "has_new_app_release": False, "has_new_question_bank": False}

    local = local_manifest()
    upd = CFG.updater()
    out = {
        "ok": True,
        "configured": True,
        "repo": repo,
        "branch": upd.get("branch") or "main",
        "app_version": CFG.APP_VERSION,
        "has_new_app_release": False,
        "has_new_question_bank": False,
        "release": None,
        "commit": None,
        "local_commit": upd.get("last_sync_commit") or "",
        "local_bank_version": (upd.get("last_bank_version")
                               or local.get("bank_version") or ""),
        "local_manifest": local,
        "remote_manifest": None,
        "source": "",
        "detail": "",
        "notify": bool(upd.get("notify", True)),
    }

    # 0) 版本清单（首选）：一次 raw 请求拿到所有信息
    remote, src = fetch_manifest()
    if remote:
        out["remote_manifest"] = remote
        out["source"] = src
        rv = remote.get("app_version") or ""
        if rv:
            out["has_new_app_release"] = _ver_tuple(rv) > _ver_tuple(CFG.APP_VERSION)
            out["release"] = {
                "tag": rv if rv.lower().startswith("v") else f"v{rv}",
                "name": rv,
                "url": remote.get("release_url") or f"https://github.com/{repo}/releases",
                "published_at": remote.get("bank_updated_at") or "",
                "notes": (remote.get("app_release_notes") or "")[:600],
            }
        out["commit"] = {
            "sha": "",
            "sha_full": "",
            "message": (remote.get("bank_changelog")
                        or f"题库版本 {remote.get('bank_version') or '未标注'}")[:200],
            "date": 0.0,
            "url": f"https://github.com/{repo}/blob/"
                   f"{out['branch']}/{VERSION_REL}",
        }
        rbv = (remote.get("bank_version") or "").strip()
        lbv = (out["local_bank_version"] or "").strip()
        if rbv and rbv != lbv:
            out["has_new_question_bank"] = True
        elif not rbv:
            # 远端没标版本号：退回「最新提交时间 vs 本地同步时间」
            local_ts = float(upd.get("last_sync_at") or 0)
            if not local_ts:
                try:
                    local_ts = os.path.getmtime(CFG.DATA / "questions.json")
                except OSError:
                    local_ts = 0.0
            out["local_synced_at"] = local_ts
            try:
                remote_ts = float(calendar.timegm(time.strptime(
                    (remote.get("bank_updated_at") or "").strip(),
                    "%Y-%m-%d %H:%M:%S")))
            except Exception:                          # noqa: BLE001
                remote_ts = 0.0
            out["has_new_question_bank"] = bool(
                remote_ts and remote_ts > local_ts + 60)
        out["detail"] = "已通过版本清单检查"
        return out

    out["manifest_error"] = src          # 清单拿不到（还没提交 / 网络不通）

    # 1) 最新 Release（没有发过 Release 的仓库会 404，不算错）
    try:
        rel = _get_json(f"https://api.github.com/repos/{repo}/releases/latest")
        if isinstance(rel, dict) and rel.get("tag_name"):
            newest = _ver_tuple(rel["tag_name"])
            out["release"] = {
                "tag": rel.get("tag_name"),
                "name": rel.get("name") or rel.get("tag_name"),
                "url": rel.get("html_url") or f"https://github.com/{repo}/releases",
                "published_at": rel.get("published_at") or "",
                "notes": (rel.get("body") or "")[:600],
            }
            out["has_new_app_release"] = newest > _ver_tuple(CFG.APP_VERSION)
    except Exception as exc:                           # noqa: BLE001
        out["release_error"] = str(exc)[:160]

    # 2) 题库文件在分支上的最后一次提交
    try:
        branch = out["branch"]
        commits = _get_json(
            f"https://api.github.com/repos/{repo}/commits"
            f"?path=data/questions.json&sha={quote(branch)}&per_page=1")
        if isinstance(commits, list) and commits:
            c = commits[0]
            meta = c.get("commit") or {}
            sha = c.get("sha") or ""
            msg = (meta.get("message") or "").strip().split("\n")[0]
            ts = 0.0
            try:
                # GitHub 给的是 UTC（...Z），用 timegm 别用 mktime/local 时区
                ts = float(calendar.timegm(time.strptime(
                    (meta.get("committer") or {}).get("date", ""),
                    "%Y-%m-%dT%H:%M:%SZ")))
            except Exception:                          # noqa: BLE001
                ts = 0.0
            out["commit"] = {"sha": sha[:10], "sha_full": sha,
                             "message": msg, "date": ts,
                             "url": c.get("html_url") or ""}
            local_sha = out["local_commit"]
            local_ts = float(CFG.updater().get("last_sync_at") or 0)
            if not local_ts:
                try:
                    local_ts = os.path.getmtime(CFG.DATA / "questions.json")
                except OSError:
                    local_ts = 0.0
            out["local_synced_at"] = local_ts
            by_sha = bool(local_sha) and bool(sha) and sha != local_sha
            by_time = ts > local_ts + 60
            out["has_new_question_bank"] = bool(by_sha or (by_time and not local_sha))
    except Exception as exc:                           # noqa: BLE001
        out["commit_error"] = str(exc)[:160]

    if not out["release"] and not out["commit"]:
        out["ok"] = False
        errs = f"{out.get('release_error', '')} {out.get('commit_error', '')}"
        if "404" in errs:
            out["detail"] = (f"GitHub 上找不到仓库 {repo}，或仓库里还没有 data/questions.json。"
                             "检查设置里的仓库地址（格式 owner/repo），或先手动导入题库包。")
        elif "403" in errs or "rate limit" in errs.lower():
            out["detail"] = "GitHub API 限流了（未登录每小时 60 次），过几分钟再试。"
        else:
            out["detail"] = ("连不上 GitHub（校园网常需要代理）。"
                             "可以先去 Releases 手动下载题库包，在设置里导入。")
    return out


# ---------------------------------------------------------------- 合并策略


def _local_snapshot(qs: list) -> dict:
    """记下本地已有的 AI 成果，供同步后补回。"""
    snap = {}
    for q in qs or []:
        qid = q.get("id")
        om = q.get("obsidian_match") or {}
        ta = om.get("targeted_analysis") or {}
        mat = om.get("option_matrix") or {}
        if not qid:
            continue
        if (ta.get("key_point") or "").strip() or mat:
            snap[qid] = {
                "targeted_analysis": ta if (ta.get("key_point") or "").strip() else None,
                "option_matrix": mat,
                "option_matrix_ai": bool(om.get("option_matrix_ai")),
            }
    return snap


def _has_text(d: dict) -> bool:
    return any(str(v or "").strip() for v in (d or {}).values())


def merge_bank(new_qs: list, old_qs: list) -> tuple[list, int]:
    """远端题库覆盖本地，但本地已生成的 AI 解析要留住。返回 (题库, 补回条数)。"""
    snap = _local_snapshot(old_qs)
    kept = 0
    for q in new_qs:
        mine = snap.get(q.get("id"))
        if not mine:
            continue
        om = q.setdefault("obsidian_match", {}) or {}
        ta = om.get("targeted_analysis") or {}
        if not (ta.get("key_point") or "").strip() and mine["targeted_analysis"]:
            om["targeted_analysis"] = mine["targeted_analysis"]
            kept += 1
        if not _has_text(om.get("option_matrix")) and _has_text(mine["option_matrix"]):
            om["option_matrix"] = mine["option_matrix"]
            if mine["option_matrix_ai"]:
                om["option_matrix_ai"] = True
            kept += 1
        q["obsidian_match"] = om
    return new_qs, kept


def _valid_bank(data) -> bool:
    if not isinstance(data, list) or not data:
        return False
    first = data[0]
    return all(k in first for k in ("id", "stem", "options", "answer"))


# ---------------------------------------------------------------- 同步主流程


def sync_bank() -> dict:
    """一键热更新题库 + 增量配图。整个过程不碰 user_progress / user_config。"""
    if state().get("running"):
        return {"ok": False, "detail": "已经在同步了，稍等几秒"}

    _set(running=True, phase="fetch", done=0, total=0,
         message="正在连接 GitHub…", started=time.time(),
         finished=0.0, result=None)

    try:
        result = _sync_bank_inner()
        _set(running=False, phase="done" if result.get("ok") else "error",
             message=result.get("detail") or "同步完成",
             finished=time.time(), result=result)
        return result
    except Exception as exc:                           # noqa: BLE001
        res = {"ok": False, "detail": f"同步失败：{type(exc).__name__}: {exc}"}
        _set(running=False, phase="error", message=res["detail"],
             finished=time.time(), result=res)
        return res


def _sync_bank_inner() -> dict:
    if not CFG.repo():
        return {"ok": False, "detail": "没有配置 GitHub 仓库"}

    bank_path = CFG.DATA / "questions.json"
    media_dir = CFG.DATA / "media"
    media_dir.mkdir(parents=True, exist_ok=True)

    # 同步前先记住本地的 AI 成果与旧题库
    old_qs = _read_json(bank_path, [])
    snap_before = _local_snapshot(old_qs if isinstance(old_qs, list) else [])

    # 1) 下载题库
    _set(phase="bank", message="正在下载最新题库…", done=0, total=0)
    raw, used_url = _fetch_any("data/questions.json", timeout=TIMEOUT)
    try:
        new_qs = json.loads(raw.decode("utf-8"))
    except Exception as exc:                           # noqa: BLE001
        return {"ok": False, "detail": f"下载到的题库不是合法 JSON（{exc}）"}
    if not _valid_bank(new_qs):
        return {"ok": False, "detail": "下载到的题库格式不对（缺 id/stem/options/answer）"}

    # 2) 增量配图：远端有、本地没有的才下载
    remote_imgs = _images_of(new_qs)
    missing = [p for p in remote_imgs if not (media_dir / p).is_file()]
    _set(phase="media", done=0, total=len(missing),
         message=f"配图 {len(remote_imgs)} 张，缺 {len(missing)} 张")
    got, failed = 0, []
    for i, rel in enumerate(missing, 1):
        try:
            blob, _ = _fetch_any(f"data/media/{rel}", timeout=MEDIA_TIMEOUT)
        except Exception:                              # noqa: BLE001
            failed.append(rel)
            _set(done=i, message=f"配图 {i}/{len(missing)}（{Path(rel).name} 失败）")
            continue
        target = media_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
        got += 1
        _set(done=i, message=f"配图 {i}/{len(missing)}")

    # 3) 安全合并（保留本地 AI 解析），然后原子替换
    _set(phase="merge", message="正在合并本地解析缓存…")
    merged, kept = merge_bank(new_qs, old_qs if isinstance(old_qs, list) else [])
    # sidecar 里的解析不受影响，但把题库里已有的塞回 sidecar 反而会重复，这里不动 sidecar
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = None
    if bank_path.is_file():
        backup = bank_path.with_name(f"questions.bak-{stamp}.json")
        shutil.copy2(bank_path, backup)
    _write_json_atomic(bank_path, merged)

    # 4) 记录同步点（写 user_config.json 的 update 段，不动 llm / progress）
    sha = ""
    try:
        commits = _get_json(
            f"https://api.github.com/repos/{CFG.repo()}/commits"
            f"?path=data/questions.json&sha={CFG.updater().get('branch') or 'main'}&per_page=1")
        if isinstance(commits, list) and commits:
            sha = commits[0].get("sha") or ""
    except Exception:                                  # noqa: BLE001
        pass

    # 顺手把远端的版本清单落到本地：下次启动 check 时本地就有对照基线，
    # 也方便用户在「设置 → 数据与备份」里看到当前题库版本。
    bank_version = ""
    try:
        remote_manifest, _src = fetch_manifest()
        if remote_manifest:
            bank_version = (remote_manifest.get("bank_version") or "").strip()
            try:
                _write_json_atomic(CFG.DATA / "version.json", remote_manifest)
            except Exception:                          # noqa: BLE001
                pass
    except Exception:                                  # noqa: BLE001
        pass
    CFG.remember_sync(sha, bank_version=bank_version)

    # 5) 让 server 的题库缓存失效
    try:
        import server as S                              # 延迟导入，避免循环依赖
        with S._cache_lock:
            S._cache.pop(str(S.QUESTIONS), None)
    except Exception:                                  # noqa: BLE001
        pass

    msg = ("已同步最新题库与笔记（保留个人刷题记录）"
           + f" · {len(merged)} 道题 · 新图 {got} 张"
           + (f" · {len(failed)} 张图下载失败" if failed else "")
           + (f" · 保留本地 AI 解析 {kept} 处" if kept else ""))
    return {
        "ok": True,
        "detail": msg,
        "total": len(merged),
        "images_total": len(remote_imgs),
        "images_downloaded": got,
        "images_failed": failed[:20],
        "kept_local_analysis": kept,
        "commit": sha[:10],
        "bank_version": bank_version,
        "source": used_url,
        "backup": backup.name if backup else "",
        "snapshot": len(snap_before),
    }


# ---------------------------------------------------------------- 应用本体自动更新

import subprocess
import sys
import threading
import zipfile

_APP_LOCK = Lock()
_APP_STATE = {
    "running": False,
    "phase": "",              # check | download | extract | replace | git_pull | restarting | done | error
    "percent": 0,             # 0..100
    "downloaded_bytes": 0,
    "total_bytes": 0,
    "message": "",
    "mode": "",               # portable | source
    "restarting": False,
    "manual_url": "",
    "started": 0.0,
    "finished": 0.0,
    "result": None,
}

# 镜像加速队列（优先 ghp.ci / mirror.ghproxy.com，配合直连回退）
_RELEASE_PROXIES = ("https://ghp.ci/", "https://mirror.ghproxy.com/")


def _set_app(**kw) -> None:
    with _APP_LOCK:
        _APP_STATE.update(kw)


def app_update_state() -> dict:
    with _APP_LOCK:
        return dict(_APP_STATE)


def _resolve_release_zip_urls(repo: str, target_ver: str = "",
                              remote_manifest: dict | None = None) -> tuple[list[str], str]:
    """解析最新 Release 便携包下载地址列表（去重保序）与手动下载页地址。"""
    manual_url = ((remote_manifest or {}).get("release_url")
                  or f"https://github.com/{repo}/releases")
    urls: list[str] = []

    def add(u: str) -> None:
        u = (u or "").strip()
        if u and u not in urls:
            urls.append(u)

    if remote_manifest:
        for k in ("download_url", "portable_url", "asset_url"):
            if remote_manifest.get(k):
                add(str(remote_manifest[k]))

    # 查询 GitHub Releases API（尝试直连与系统代理）
    api_url = f"https://api.github.com/repos/{repo}/releases/latest"
    for px in (None, _SYSTEM):
        try:
            raw = _get(api_url, timeout=8,
                       headers={"Accept": "application/vnd.github+json"},
                       proxy=px)
            rel = json.loads(raw.decode("utf-8"))
            if isinstance(rel, dict):
                if rel.get("html_url"):
                    manual_url = rel["html_url"]
                if not target_ver and rel.get("tag_name"):
                    target_ver = str(rel["tag_name"])
                assets = rel.get("assets") or []
                # 优先匹配 AnatomyStudio_Portable*.zip，其次任意 .zip
                for a in assets:
                    name = str(a.get("name") or "")
                    dl = str(a.get("browser_download_url") or "")
                    if dl and name.lower().startswith("anatomystudio_portable") and name.lower().endswith(".zip"):
                        add(dl)
                for a in assets:
                    name = str(a.get("name") or "")
                    dl = str(a.get("browser_download_url") or "")
                    if dl and name.lower().endswith(".zip"):
                        add(dl)
                break
        except Exception:                              # noqa: BLE001
            continue

    # 常规 Release Asset 下载地址兜底（绕过 API 限流）
    ver_clean = (target_ver or "").strip().lstrip("vV")
    if ver_clean:
        tag = f"v{ver_clean}"
        add(f"https://github.com/{repo}/releases/download/{tag}/AnatomyStudio_Portable_v{ver_clean}.zip")
        add(f"https://github.com/{repo}/releases/download/{tag}/AnatomyStudio_Portable.zip")
    add(f"https://github.com/{repo}/releases/latest/download/AnatomyStudio_Portable.zip")
    if ver_clean:
        add(f"https://github.com/{repo}/releases/latest/download/AnatomyStudio_Portable_v{ver_clean}.zip")

    return urls, manual_url


def _download_zip_with_progress(asset_urls: list[str], dest_zip: Path) -> str:
    """配合国内镜像加速队列（ghp.ci、mirror.ghproxy.com）与直连回退，流式下载 zip 并实时上报进度。"""
    candidates: list[tuple[str, object]] = []
    for base in asset_urls:
        for p in _RELEASE_PROXIES:
            candidates.append((f"{p}{base}", _SYSTEM))
            candidates.append((f"{p}{base}", None))
        candidates.append((base, _SYSTEM))
        candidates.append((base, None))

    errors: list[str] = []
    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    tmp_zip = dest_zip.with_suffix(".part")

    for url, px in candidates:
        host = url.split("/")[2] if "://" in url else url[:32]
        tag = "直连" if px is None else "代理"
        try:
            _set_app(phase="download",
                     message=f"正在连接下载源（{host}·{tag}）…")
            req = urllib.request.Request(
                url,
                headers={"User-Agent": _ua(), "Accept": "application/octet-stream,*/*"},
            )
            if px is _SYSTEM:
                opener = urllib.request.urlopen
            else:
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({"http": px, "https": px} if px else {})
                ).open

            with opener(req, timeout=25) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                downloaded = 0
                with tmp_zip.open("wb") as fh:
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        fh.write(chunk)
                        downloaded += len(chunk)
                        if total > 0:
                            pct = min(82, 10 + int((downloaded / total) * 72))
                            msg = (f"正在下载更新包… {downloaded / 1048576:.1f} / "
                                   f"{total / 1048576:.1f} MB ({pct}%)")
                        else:
                            pct = min(80, 12 + int(downloaded / (1024 * 1024)))
                            msg = f"正在下载更新包… {downloaded / 1048576:.1f} MB"
                        _set_app(phase="download", percent=pct,
                                 downloaded_bytes=downloaded, total_bytes=total,
                                 message=msg)

            if not tmp_zip.is_file() or tmp_zip.stat().st_size < 1024:
                raise RuntimeError("下载到的文件过小或为空")
            if not zipfile.is_zipfile(tmp_zip):
                raise RuntimeError("下载到的文件不是有效的 ZIP 压缩包")
            os.replace(tmp_zip, dest_zip)
            return url
        except urllib.error.HTTPError as exc:
            errors.append(f"{host}·{tag}: HTTP {exc.code}")
        except Exception as exc:                       # noqa: BLE001
            errors.append(f"{host}·{tag}: {type(exc).__name__}")
        finally:
            try:
                tmp_zip.unlink(missing_ok=True)
            except OSError:
                pass

    raise RuntimeError("无法下载最新便携包（" + "；".join(errors[:6]) + "）")


def _generate_apply_update_bat(app_root: Path, extracted_root: Path) -> Path:
    """动态生成同级批处理脚本 _apply_update.bat：
    等待 2 秒释放文件锁 -> 覆盖程序文件（严格排除 user_config.json 与 user_progress.json）
    -> 重启新版本 -> 清理 _update_tmp 与自身脚本。
    """
    bat_path = app_root / "_apply_update.bat"
    rel_src = os.path.relpath(extracted_root, app_root)
    script = f"""@echo off
chcp 65001 >nul
title Anatomy Studio Auto-Updater
cd /d "%~dp0"
echo.
echo   ========================================================
echo     Anatomy Studio 正在应用新版本更新，请稍候 (约 2 秒)...
echo   ========================================================
echo.
timeout /t 2 /nobreak >nul

robocopy "%~dp0{rel_src}" "%~dp0." /E /XF "user_config.json" "user_progress.json" "_apply_update.bat" /XD "_update_tmp" ".git" >nul

echo   更新完成，正在重新启动 Anatomy Studio...
if exist "%~dp0AnatomyStudio.exe" (
    start "" "%~dp0AnatomyStudio.exe"
) else if exist "%~dp0启动 Anatomy Studio.bat" (
    start "" "%~dp0启动 Anatomy Studio.bat"
)

rmdir /s /q "%~dp0_update_tmp" 2>nul
del "%~f0" & exit
"""
    bat_path.write_text(script.replace("\r\n", "\n").replace("\n", "\r\n"),
                        encoding="utf-8", newline="")
    return bat_path


def _apply_portable_update(repo: str, target_ver: str,
                           remote_manifest: dict | None, manual_url: str) -> dict:
    """Windows 便携版无感热替换与重启。"""
    app_root = CFG.HERE
    tmp_dir = app_root / "_update_tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    asset_urls, resolved_manual = _resolve_release_zip_urls(repo, target_ver, remote_manifest)
    manual_url = resolved_manual or manual_url
    _set_app(manual_url=manual_url, percent=8,
             message="正在获取最新 Release 便携包下载地址…")

    zip_path = tmp_dir / "AnatomyStudio_Portable.zip"
    used_url = _download_zip_with_progress(asset_urls, zip_path)

    _set_app(phase="extract", percent=86,
             message="正在解压新版本并校验个人数据隔离…")
    extract_dir = tmp_dir / "extracted"
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(extract_dir)

    # 定位解压后的根目录（兼容顶层套一层 AnatomyStudio_Portable/ 的情况）
    children = [p for p in extract_dir.iterdir() if p.name != "__MACOSX"]
    src_root = children[0] if (len(children) == 1 and children[0].is_dir()) else extract_dir

    # 双重保险：从待覆盖源目录里直接删掉 user_config.json 与 user_progress.json
    for guarded in ("user_config.json", "user_progress.json"):
        g_path = src_root / "data" / guarded
        if g_path.exists():
            try:
                g_path.unlink()
            except OSError:
                pass

    # 同步更新 version.json，保证重启后版本号与远端一致
    if remote_manifest:
        try:
            (src_root / "data").mkdir(parents=True, exist_ok=True)
            _write_json_atomic(src_root / "data" / "version.json", remote_manifest)
            _write_json_atomic(CFG.DATA / "version.json", remote_manifest)
        except Exception:                              # noqa: BLE001
            pass

    _set_app(phase="replace", percent=95,
             message="正在拉起热替换脚本并准备重启应用…")
    bat_path = _generate_apply_update_bat(app_root, src_root)

    res = {
        "ok": True,
        "mode": "portable",
        "restarting": True,
        "source": used_url,
        "manual_url": manual_url,
        "detail": "更新完成，正在自动重启应用...",
    }
    _set_app(running=False, phase="restarting", percent=100,
             restarting=True, message=res["detail"],
             finished=time.time(), result=res)

    # 拉起同级 _apply_update.bat，并在 1.2 秒后优雅退出释放文件锁
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if os.name == "nt" else 0
    subprocess.Popen(["cmd.exe", "/c", str(bat_path)],
                     cwd=str(app_root), creationflags=creationflags)
    threading.Timer(1.2, lambda: os._exit(0)).start()
    return res


def _apply_source_update(repo: str, target_ver: str,
                         remote_manifest: dict | None, manual_url: str) -> dict:
    """源码运行模式兜底：检测到 .git 目录时执行 git pull --ff-only 拉取最新代码。"""
    app_root = CFG.HERE
    _set_app(phase="git_pull", percent=25, mode="source",
             manual_url=manual_url,
             message="检测到源码运行模式（.git），正在执行 git pull --ff-only…")

    old_head = ""
    try:
        old_head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=str(app_root),
            text=True, encoding="utf-8", errors="replace", timeout=5
        ).strip()
    except Exception:                                  # noqa: BLE001
        pass

    proc = subprocess.run(
        ["git", "pull", "--ff-only"],
        cwd=str(app_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=35,
    )
    if proc.returncode != 0:
        err_text = (proc.stderr or proc.stdout or "git pull 失败").strip()
        raise RuntimeError(
            f"源码模式 git pull --ff-only 未能自动合并（{err_text[:180]}）。"
            "请先提交或清理本地未提交改动，或点击下方链接前往 GitHub Releases 手动下载最新便携包。"
        )

    _set_app(phase="replace", percent=78,
             message="代码拉取完成，正在检查前端改动与同步题库清单…")

    new_head = ""
    web_changed = False
    try:
        new_head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=str(app_root),
            text=True, encoding="utf-8", errors="replace", timeout=5
        ).strip()
        if old_head and new_head and old_head != new_head:
            diff_files = subprocess.check_output(
                ["git", "diff", "--name-only", old_head, new_head],
                cwd=str(app_root), text=True, encoding="utf-8", errors="replace", timeout=5
            ).splitlines()
            web_changed = any(f.startswith("web/") for f in diff_files)
    except Exception:                                  # noqa: BLE001
        pass

    if remote_manifest:
        try:
            _write_json_atomic(CFG.DATA / "version.json", remote_manifest)
            if remote_manifest.get("app_version"):
                CFG.APP_VERSION = str(remote_manifest["app_version"]).strip()
        except Exception:                              # noqa: BLE001
            pass

    # 让 server 的题库缓存失效
    try:
        import server as S
        with S._cache_lock:
            S._cache.pop(str(S.QUESTIONS), None)
    except Exception:                                  # noqa: BLE001
        pass

    hint = "（检测到 web/ 前端源码有更新，建议运行 npm run build 重新编译前端）" if web_changed else ""
    msg = f"更新完成（git pull --ff-only 已同步最新代码）{hint}，正在自动重启应用..."
    res = {
        "ok": True,
        "mode": "source",
        "restarting": True,
        "web_changed": web_changed,
        "manual_url": manual_url,
        "detail": msg,
    }
    _set_app(running=False, phase="restarting", percent=100,
             restarting=True, message=msg,
             finished=time.time(), result=res)
    return res


def _run_app_update(force_mode: str = "") -> dict:
    repo = CFG.repo()
    if not repo:
        res = {"ok": False, "detail": "没有配置 GitHub 仓库地址"}
        _set_app(running=False, phase="error", percent=0,
                 message=res["detail"], finished=time.time(), result=res)
        return res

    manual_url = f"https://github.com/{repo}/releases"
    _set_app(phase="check", percent=5, manual_url=manual_url,
             message="正在检查远端最新版本信息…")

    remote_manifest, _src = fetch_manifest()
    target_ver = (remote_manifest or {}).get("app_version") or ""
    if (remote_manifest or {}).get("release_url"):
        manual_url = remote_manifest["release_url"]

    is_frozen = getattr(sys, "frozen", False)
    has_git = (CFG.HERE / ".git").exists()
    use_portable = (force_mode == "portable") or is_frozen or (not has_git)

    try:
        if use_portable:
            _set_app(mode="portable")
            return _apply_portable_update(repo, target_ver, remote_manifest, manual_url)
        return _apply_source_update(repo, target_ver, remote_manifest, manual_url)
    except Exception as exc:                           # noqa: BLE001
        res = {
            "ok": False,
            "manual_url": manual_url,
            "detail": f"自动更新失败：{exc}",
        }
        _set_app(running=False, phase="error",
                 message=res["detail"], manual_url=manual_url,
                 finished=time.time(), result=res)
        return res


def start_app_update(payload: dict | None = None) -> dict:
    """启动异步应用本体更新任务，前端通过 /api/updater/app-update-status 轮询实时进度。"""
    cur = app_update_state()
    if cur.get("running"):
        return cur
    force_mode = str((payload or {}).get("mode") or "").strip()
    is_frozen = getattr(sys, "frozen", False)
    has_git = (CFG.HERE / ".git").exists()
    mode = "portable" if (force_mode == "portable" or is_frozen or not has_git) else "source"
    repo = CFG.repo()
    manual_url = f"https://github.com/{repo}/releases" if repo else ""

    _set_app(
        running=True,
        phase="check",
        percent=3,
        downloaded_bytes=0,
        total_bytes=0,
        message="正在准备自动更新…",
        mode=mode,
        restarting=False,
        manual_url=manual_url,
        started=time.time(),
        finished=0.0,
        result=None,
    )
    t = threading.Thread(target=_run_app_update, args=(force_mode,), daemon=True)
    t.start()
    return app_update_state()

