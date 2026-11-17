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
from pathlib import Path
from threading import Lock
from urllib.parse import quote

import config as CFG

TIMEOUT = 10           # 单个请求超时（秒）
MEDIA_TIMEOUT = 20     # 图片稍大，给宽一点

# 版本清单：随仓库提交，一次 GET 就能拿到「客户端版本 + 题库版本 + 更新说明」，
# 不用碰 api.github.com（未登录每小时只有 60 次，校园网还常超时）。
VERSION_REL = "data/version.json"

# 下载候选链：直连优先，失败再套代理前缀
_PROXIES = ("https://mirror.ghproxy.com/", "https://ghp.ci/")

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


def _get(url: str, timeout: int = TIMEOUT, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _ua(),
                                               "Accept": "*/*",
                                               **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _get_json(url: str, timeout: int = TIMEOUT) -> dict | list:
    raw = _get(url, timeout, {"Accept": "application/vnd.github+json"})
    return json.loads(raw.decode("utf-8"))


def _raw_candidates(rel: str) -> list[str]:
    """给定仓库内相对路径，返回「直连 + 各代理」的候选下载地址。"""
    repo = CFG.repo()
    if not repo:
        return []
    branch = CFG.updater().get("branch") or "main"
    path = quote(rel, safe="/")
    direct = f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"
    return [direct] + [f"{p}{direct}" for p in _PROXIES]


def _fetch_first(rel: str, timeout: int = TIMEOUT) -> tuple[bytes, str]:
    """按候选链依次尝试；返回 (内容, 实际 URL)。全失败抛最后一个错误。"""
    errors = []
    for url in _raw_candidates(rel):
        try:
            return _get(url, timeout), url
        except Exception as exc:                      # noqa: BLE001 — 逐个兜底
            errors.append(f"{url.split('/')[2]}: {type(exc).__name__}")
            continue
    raise RuntimeError("所有下载地址都失败了（" + "；".join(errors) + "）")


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
        raw, url = _fetch_first(VERSION_REL, timeout=TIMEOUT)
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
    raw, used_url = _fetch_first("data/questions.json", timeout=TIMEOUT)
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
            blob, _ = _fetch_first(f"data/media/{rel}", timeout=MEDIA_TIMEOUT)
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
