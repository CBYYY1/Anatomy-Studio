"""Step 1 · 数据清洗 + Obsidian 深度挂载（v2，Apple Studio 专用）

与第一版 `D:\解剖助手\build_question_bank.py`（bank/web 那套）的区别：
  1. 新增 `obsidian_match.images` —— 从命中小节里解析 ![[...]] / ![](path)，
     定位成库里真实存在的相对路径，供前端灯箱直接取图。
  2. `module` / `chapter` 按新 Schema 归一：module 归到「系统解剖学」，
     chapter 归到「章」级（如「第七章 生殖系统」→「生殖系统」），
     原始的完整路径保留在 meta.chapter_path 里。
  3. 输出到 `studio/data/`，不覆盖旧产物。

匹配算法本身直接复用 v1 的 engine（BM25 二元组主通道 + 术语兜底 +
选项级去重 + 上下文窗口锚点），保证两套前端看到的是同一份证据，
不会因为两处实现漂移而互相矛盾。

用法：
  $env:PYTHONUTF8='1'
  python build_question_bank.py
"""
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.dirname(HERE)                 # D:\解剖助手
sys.path.insert(0, WORK)

import build_question_bank as core           # noqa: E402  v1 的匹配引擎

VAULT = core.VAULT
OUT = os.path.join(HERE, "data")
LETTERS = core.LETTERS
log = core.log
read = core.read
dump = core.dump

MAX_IMAGES = 4
IMG_WIKI = re.compile(r"!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")
IMG_MD = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


# ---------------------------------------------------------------- 模块 / 章节归一

CHAPTER_RE = re.compile(r"^第[一二三四五六七八九十百]+章\s*")
NUM_PREFIX = re.compile(r"^[一二三四五六七八九十百]+[、.．]\s*")
SEC_PREFIX = re.compile(r"^第[一二三四五六七八九十百]+节\s*")


def norm_module(path):
    """题库全部来自《人体结构学》系统解剖学部分，统一归到系统解剖学。

    若将来混入组织学/胚胎学的题（章名含「基本组织」「胚胎」），归到组织胚胎学。
    """
    joined = "-".join(path)
    if any(w in joined for w in ("基本组织", "胚胎学", "组织学")):
        return "组织胚胎学"
    return "系统解剖学"


def norm_chapter(path):
    """取「章」级的干净名字：第七章 生殖系统 → 生殖系统。"""
    for t in path:
        m = CHAPTER_RE.match(t)
        if m:
            return t[m.end():].strip() or t
    last = path[-1] if path else ""
    return SEC_PREFIX.sub("", NUM_PREFIX.sub("", last)).strip()


# ---------------------------------------------------------------- 纯方位题识别

# 方位 / 形状 / 大小之类的「非概念词」。有些题的选项只有这些词（"向内侧 / 向上 /
# 椭圆形"）或者只有数字加量词（"2对 / 3对"），题干里也没有可检索的名词；把它们
# 拼进 BM25 查询会被高频方位二元组带偏（实测 anat_3831「肾移位方向」被匹配到
# 「（四）眼球外肌」，因为那段里"转向内侧/转向外侧"出现密集）。
DIR_SHAPE = (
    "向内上方", "向外上方", "向内下方", "向外下方", "内上方", "外下方", "上内侧", "下外侧",
    "前上方", "后下方", "向内", "向外", "向上", "向下", "向前", "向后", "向上内", "向下内",
    "内上", "外上", "内下", "外下", "前内", "后外",
    "内侧", "外侧", "前方", "后方", "上方", "下方", "上端", "下端",
    "椭圆形", "三角形", "菱形", "梭形", "圆形", "方形", "不规则形",
    "梨形", "锥体形", "圆柱形", "漏斗形", "半月形",
)
_DIR_SORTED = sorted(DIR_SHAPE, key=len, reverse=True)

# 量词：数字选项「2对」「3条」去掉数字和量词后什么都不剩，属于噪声
QUANT = set("对个条块支根层处次种类只侧半边端部位")
STRIP_RE = re.compile(r"[^\u4e00-\u9fa5A-Za-z0-9]")


def _is_noise_option(text):
    """选项去掉方位/形状词、数字、量词后是否什么都不剩（=没有可检索的解剖内容）。

    注意不能简单看「剩余长度 < 2」：那样「胃 / 脾 / 膈 / 肝 / 胰」这种单字器官
    会被误判成噪声（anat_3651「右肾外侧邻」就是这么被带偏的）。
    """
    c = text
    for w in _DIR_SORTED:
        c = c.replace(w, "")
    c = STRIP_RE.sub("", c)
    if not c:
        return True
    if all(ch.isdigit() or ch in QUANT for ch in c):
        return True
    return False


def is_direction_only(options):
    """所有选项都是噪声选项 → 题干必须自己扛起检索。"""
    return bool(options) and all(_is_noise_option(t) for t in options.values())


def topic_words(zjname):
    """从「第一节 肾」「一、颅骨」这类章节名里抠出主题名词，用于过滤候选小节。"""
    s = zjname or ""
    s = re.sub(r"^第[一二三四五六七八九十百]+[节章]\s*", "", s)
    s = re.sub(r"^[一二三四五六七八九十]+、\s*", "", s)
    s = re.sub(r"\s.*$", "", s).strip()
    # 1 字也要放行：「肾」「心」「肝」是最常见的主题词，卡 2 字会漏掉大量题
    return [s] if 1 <= len(s) <= 8 else []


# ---------------------------------------------------------------- 图片解析

def index_vault_media():
    """建立「文件名 -> 相对路径」索引，用于解析 ![[只有文件名.png]] 这种写法。"""
    by_name, by_path = {}, {}
    for root, _dirs, files in os.walk(VAULT):
        if "\\.obsidian" in root or "\\.check" in root:
            continue
        for f in files:
            if os.path.splitext(f)[1].lower() not in (
                    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, VAULT).replace("\\", "/")
            by_path[rel] = True
            by_name.setdefault(f, rel)
    return by_name, by_path


def extract_images(text, by_name, by_path, limit=MAX_IMAGES):
    """从 markdown 片段里抽出图片的相对路径（去重、只保留真实存在的）。"""
    out, seen = [], set()
    for raw in IMG_WIKI.findall(text) + IMG_MD.findall(text):
        p = raw.strip().strip('"').strip("'")
        if not p or p.startswith(("http://", "https://", "data:")):
            continue
        p = p.replace("\\", "/").lstrip("./")
        rel = None
        if p in by_path:
            rel = p
        else:
            # Obsidian 允许只写文件名，靠全库唯一性解析
            rel = by_name.get(os.path.basename(p))
        if not rel or rel in seen:
            continue
        seen.add(rel)
        out.append(rel)
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- 版本清单

VERSION_PATH = os.path.join(OUT, "version.json")

APP_RELEASE_NOTES = ("首个正式版本发布：支持双轨解析、选项矩阵与考前急救队列。")
BANK_CHANGELOG = "更新章节笔记映射与靶向解析缓存"


def _read_old_manifest():
    try:
        with open(VERSION_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:                                  # noqa: BLE001
        return {}


def _next_bank_version(old: str) -> str:
    """题库版本号形如 2026.11.17.3 —— 同一天重跑就自增末位。"""
    today = time.strftime("%Y.%m.%d")
    old = (old or "").strip()
    if old.startswith(today + "."):
        tail = old[len(today) + 1:].split(".")[0]
        try:
            return f"{today}.{int(tail) + 1}"
        except ValueError:
            pass
    return f"{today}.1"


def write_version_manifest(questions, summary):
    """生成/更新 data/version.json（随仓库提交，供客户端检查更新）。

    这份文件是「应用内自动更新」的快路径：客户端只要 GET 一次 raw 上的
    version.json 就知道客户端要不要升级、题库有没有新内容，完全不必碰
    api.github.com 的 60 次/小时限流。

    人工维护的字段（app_release_notes / release_url）会从旧的 version.json
    继承，不会被构建脚本覆盖 —— 想改发版说明直接改文件即可。
    """
    old = _read_old_manifest()

    notes_set = set()
    for q in questions or []:
        note = ((q.get("obsidian_match") or {}).get("matched_note") or "").strip()
        if note:
            notes_set.add(note)

    media = set()
    for q in questions or []:
        for p in (q.get("obsidian_match") or {}).get("images") or []:
            p = str(p or "").strip()
            if p:
                media.add(p)

    repo = "CBYYY1/Anatomy-Studio"
    app_ver = "1.0.0"
    try:
        sys.path.insert(0, HERE)
        import config as CFG                            # noqa: E402
        repo = CFG.GITHUB_REPO or repo
        app_ver = CFG.APP_VERSION or app_ver
    except Exception:                                  # noqa: BLE001
        pass

    manifest = {
        "app_version": app_ver,
        "app_release_notes": old.get("app_release_notes") or APP_RELEASE_NOTES,
        "release_url": old.get("release_url") or f"https://github.com/{repo}/releases",
        "bank_version": _next_bank_version(old.get("bank_version") or ""),
        "bank_updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "bank_changelog": old.get("bank_changelog") or BANK_CHANGELOG,
        "stats": {
            "total_questions": len(questions or []),
            "matched_notes": len(notes_set),
            "media_count": len(media),
        },
    }
    # 顺带把构建出的真实题量写进统计，方便前端展示「题库规模」
    for k in ("choice", "single", "multiple", "with_images", "negation_warning"):
        if k in (summary or {}):
            manifest["stats"][k] = summary[k]

    tmp = VERSION_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, VERSION_PATH)
    return manifest


# ---------------------------------------------------------------- 主流程

def build():
    os.makedirs(OUT, exist_ok=True)

    qs = json.loads(read(core.RAW_Q))
    answers = json.loads(read(core.RAW_A))
    chap_best = core.load_chapter_paths()
    terms = core.build_term_dict()
    log(f"[1/6] 术语词典 {len(terms)} 条")

    sections = core.load_sections()
    log(f"[2/6] 知识库小节 {len(sections)} 段")

    matcher = core.Matcher(terms, sections)
    log(f"[3/6] 倒排就绪：正文 {len(matcher.inv)} 术语 / 标题 {len(matcher.head_inv)} / "
        f"同名概念页 {len(matcher.exact_title)}")

    by_name, by_path = index_vault_media()
    log(f"[4/6] 媒体索引 {len(by_path)} 个文件（同名索引 {len(by_name)}）")

    out_choice, out_model = [], []
    stats = dict.fromkeys(
        ("single", "multiple", "model", "with_answer", "with_context",
         "with_images", "images_total", "with_option_matrix",
         "negation", "keywords", "dir_filtered"), 0)
    cells_filled = cells_total = 0
    no_match = []
    knowledge = {}

    for q in qs:
        qid = q["id"]
        zjname = q["zjname"]
        path = chap_best.get(zjname) or [zjname]
        module = norm_module(path)
        chapter = norm_chapter(path)
        chapter_full = "-".join(core.chapter_labels(path))
        stem = (q["title"] or "").strip()
        leixing = q["leixing"]
        a = answers.get(str(qid)) or {}
        remark = (a.get("remark") or q.get("remark") or "").strip()

        if leixing == 3:
            out_model.append({
                "id": f"anat_m{qid:04d}",
                "source_id": qid,
                "type": "model",
                "module": module,
                "chapter": chapter,
                "stem": stem,
                "model_name": q.get("modelname") or "",
                "answer": [],
                "meta": {"zjid": q.get("zjid"), "zjname": zjname,
                         "nandu": q.get("nandu"), "remark": remark},
            })
            stats["model"] += 1
            continue

        opts_raw = json.loads(q["xuanxiang"] or "[]")
        options = {}
        for o in opts_raw:
            try:
                idx = int(o["label"])
            except (KeyError, ValueError, TypeError):
                continue
            if 0 <= idx < len(LETTERS):
                options[LETTERS[idx]] = (o.get("title") or "").strip()

        ans_labels = [x.strip() for x in str(a.get("answer") or "").split(",") if x.strip()]
        answer = [LETTERS[int(x)] for x in ans_labels
                  if x.isdigit() and int(x) < len(LETTERS)]

        # 纯方位/纯数字题：选项里没有可检索的解剖名词，关键词与选项定义都不该从选项取
        direction_only = is_direction_only(options)

        # ---- 关键词
        keywords, seen = [], set()

        def push(t):
            t = t.strip()
            if not t or t in seen or len(keywords) >= core.MAX_KEYWORDS:
                return
            seen.add(t)
            keywords.append(t)

        if remark and len(remark) <= 16:
            push(remark)
        used = [False] * len(stem)
        for t in matcher.extract_terms(stem, used):
            push(t)
        if direction_only:
            # 方位题的抓手只能来自题干本身：章节主题词若在题干里出现（「肾移位」
            # 对「第一节 肾」），它就是这人真正要考的对象，值得当关键词。
            for t in topic_words(zjname):
                if t in stem:
                    push(t)
        else:
            for k in sorted(options):
                for t in matcher.extract_terms(options[k]):
                    push(t)
        if len(keywords) < 4:
            srcs = [stem] if direction_only else [stem] + [options[k] for k in sorted(options)]
            for src in srcs:
                for t in matcher.suffix_terms(src, set(keywords)):
                    if len(keywords) >= core.MAX_KEYWORDS:
                        break
                    if matcher.locate(t, limit=1):
                        push(t)

        # ---- 主匹配小节（BM25 → 术语 → 章节兜底）
        #
        # 纯方位题的选项全是「向内侧/向上/椭圆形」，把它们拼进查询后 BM25 会被
        # 高频方位二元组带到毫不相干的小节（anat_3831「肾移位方向」命中「眼球外肌」）。
        # 这类题改用「题干」检索，并要求候选小节里出现题干的结构名词（肾/子宫/…）；
        # 题干没有词典名词时退回章节主题词。实测 16 道题里 12 道的命中从错位变正确。
        qtext = stem + " " + " ".join(options[k] for k in sorted(options))
        best = None
        if direction_only:
            # 题干里能被识别的结构名词（肾 / 子宫腔 / 冠状动脉…），这是「这题在问谁」的锚。
            # 三个来源都试：① 928 词词典切分；② 后缀通道切出的未登录专名；
            # ③ 章节主题词（anat_3831 的「肾」在题干里但不在词典里，只能靠章节名兜住）。
            used_s = [False] * len(stem)
            anchor_pool = [t for t in matcher.extract_terms(stem, used_s)
                           if t in matcher.inv and len(t) >= 2]
            anchor_pool += [t for t in matcher.suffix_terms(stem, set(anchor_pool))
                            if len(t) >= 2 and matcher.locate(t, limit=1)]
            anchor_pool += [t for t in topic_words(zjname) if t in stem]
            # 排序：先按在题干里出现的先后（越靠前越像主语），同位置时长词优先。
            # 依据：anat_457 里「冠状动脉」在句首、「心输出量」在后，长词优先会让
            # 锚点落到「肾的血液循环特点」上——而正确答案恰好在「心的血管」。
            anchors = sorted(set(anchor_pool),
                             key=lambda t: (stem.find(t) if stem.find(t) >= 0 else 9999, -len(t)))
            if anchors:
                bm = matcher.bm25(stem)
                ranked = [i for i, _s in sorted(bm.items(), key=lambda kv: -kv[1])[:400]]
                for a in anchors:
                    hit = None
                    if len(a) == 1:
                        # 单字锚（「肾」「心」）在正文里到处出现，只有「文件名里带这个词」
                        # 才算真正讲到了它。依据：anat_3831 锚「肾」先命中「肝肾隐窝」
                        # 的小节标题，而正确的概念页叫 005_肾的位置.md。
                        hit = next((i for i in ranked
                                    if a in os.path.basename(sections[i].path)), None)
                    if hit is None:
                        hit = next((i for i in ranked
                                    if a in sections[i].merged or a in sections[i].heading), None)
                    if hit is not None:
                        best = hit
                        break
                if best is not None:
                    stats["dir_filtered"] += 1
        if best is None:
            bm = matcher.bm25(qtext)
            best = max(bm, key=bm.get) if bm else None
        if best is None:
            scores = matcher.score_sections(keywords)
            best = max(scores, key=scores.get) if scores else None
        if best is None:
            chapter_words = [re.sub(r"^第[\d一二三四五六七八九十]+[章节、.\s]*", "", x)
                             for x in path]
            best = matcher.fallback_by_chapter(chapter_words)
        if best is None:
            best = 0
            no_match.append(qid)

        sec = sections[best]
        ctx = sec
        while ctx.parent is not None and ctx.level >= 3:
            ctx = ctx.parent

        # ---- 选项级定义（同题去重）
        #
        # 纯方位题的选项是「向内侧 / 向上 / 椭圆形」，拿着这些字去检索只会命中
        # 「内侧半月板」「向上的肌纤维」这类无关片段（anat_3831 的 A 曾拿到半月板
        # 损伤的推理）。这类题宁可不给定义，也不给错的。
        opt_matrix, used_frag = {}, set()
        if direction_only:
            opt_matrix = {k: "" for k in sorted(options)}
        else:
            for k in sorted(options):
                s = matcher.option_snippet(options[k], used_frag)
                if s:
                    used_frag.add(s)
                opt_matrix[k] = s

        # ---- 上下文窗口 + 图片
        ctx_text = core.context_window(ctx, sec, keywords, core.CONTEXT_LIMIT)
        images = extract_images(ctx_text, by_name, by_path)
        if not images:
            # 上下文窗口可能截掉了图注，退回整节找
            images = extract_images(sec.merged, by_name, by_path)

        item = {
            "id": f"anat_{qid:04d}",
            "type": "single" if leixing == 1 else "multiple",
            "module": module,
            "chapter": chapter,
            "stem": stem,
            "negation_warning": bool(core.NEG_RE.search(stem)),
            "options": options,
            "answer": answer,
            "keywords": keywords,
            "obsidian_match": {
                "matched_note": sec.path,
                "heading": sec.heading,
                "raw_markdown_context": ctx_text,
                "images": images,
                "option_matrix": opt_matrix,
            },
            "meta": {
                "source_id": qid,
                "zjid": q.get("zjid"),
                "zjname": zjname,
                "chapter_full": chapter_full,
                "chapter_path": path,
                "nandu": q.get("nandu"),
                "remark": remark,
                "has_analysis": bool(remark),
            },
        }
        out_choice.append(item)

        cells_total += len(options)
        cells_filled += sum(1 for v in opt_matrix.values() if v)
        stats["single" if leixing == 1 else "multiple"] += 1
        stats["with_answer"] += bool(answer)
        stats["with_context"] += bool(ctx_text)
        stats["with_images"] += bool(images)
        stats["images_total"] += len(images)
        stats["with_option_matrix"] += any(opt_matrix.values())
        stats["negation"] += item["negation_warning"]
        stats["keywords"] += bool(keywords)

        for t in keywords:
            if t in knowledge:
                continue
            si = None
            if matcher.head_inv.get(t):
                si = matcher.head_inv[t][0]
            elif matcher.inv.get(t):
                si = max(matcher.inv[t], key=lambda x: x[1])[0]
            if si is not None:
                knowledge[t] = {"note": sections[si].path,
                                "heading": sections[si].heading}

    dump(os.path.join(OUT, "questions.json"), out_choice)
    dump(os.path.join(OUT, "questions_model.json"), out_model)
    dump(os.path.join(OUT, "knowledge_index.json"), knowledge)

    summary = {
        "total_raw": len(qs),
        "choice": len(out_choice),
        "single": stats["single"],
        "multiple": stats["multiple"],
        "model": stats["model"],
        "with_answer": stats["with_answer"],
        "with_context": stats["with_context"],
        "with_images": stats["with_images"],
        "images_total": stats["images_total"],
        "with_option_matrix": stats["with_option_matrix"],
        "option_cells_filled": cells_filled,
        "option_cells_total": cells_total,
        "negation_warning": stats["negation"],
        "keywords_coverage": stats["keywords"],
        "no_match": len(no_match),
        "knowledge_terms": len(knowledge),
        "dir_filtered": stats["dir_filtered"],
    }
    dump(os.path.join(OUT, "bank_stats.json"), summary)

    write_version_manifest(out_choice, summary)

    rep = [
        "人体结构学 · 题库构建报告（Studio v2）",
        "=" * 52,
        f"原始题量            : {summary['total_raw']}",
        f"可作答题（选择）    : {summary['choice']}  "
        f"(单选 {summary['single']} / 多选 {summary['multiple']})",
        f"三维模型题          : {summary['model']}",
        f"有答案              : {summary['with_answer']}",
        f"有 Obsidian 正文    : {summary['with_context']}",
        f"有图谱/切片图       : {summary['with_images']}"
        f"  (共 {summary['images_total']} 张次)",
        f"有选项级定义        : {summary['with_option_matrix']}",
        f"选项级定义填充      : {cells_filled}/{cells_total} "
        f"({cells_filled / max(1, cells_total) * 100:.1f}%)",
        f"否定式题干警告      : {summary['negation_warning']}",
        f"有关键词            : {summary['keywords_coverage']}",
        f"纯方位题主题过滤    : {summary['dir_filtered']} 道走专用通道",
        f"无任何匹配          : {summary['no_match']}",
        f"知识点索引条目      : {summary['knowledge_terms']}",
        "",
        "输出：data/questions.json / data/questions_model.json / data/knowledge_index.json",
    ]
    with open(os.path.join(OUT, "build_report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(rep) + "\n")
    log("[6/6] 完成")
    log("\n".join(rep))


if __name__ == "__main__":
    build()
