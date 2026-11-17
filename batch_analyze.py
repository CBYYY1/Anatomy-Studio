"""按章节批量预生成「靶向破题精析」。

用法
----
    python batch_analyze.py --chapter 消化系统          # 只跑这一章
    python batch_analyze.py --chapter 消化系统 --limit 20
    python batch_analyze.py --all                       # 全库 1917 题（慢，费 token）
    python batch_analyze.py --chapter 消化系统 --local   # 不调模型，只灌本地兜底
    python batch_analyze.py --write                     # 把 sidecar 焊进 questions.json

默认并发 4（改 .env 的 ANALYZE_CONCURRENCY）。已在缓存里的题自动跳过，
所以这个脚本可以随时 Ctrl+C 中断、下次接着跑。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import analysis as AI

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
QUESTIONS = DATA / "questions.json"


def load_questions() -> list:
    if not QUESTIONS.exists():
        sys.exit(f"找不到题库：{QUESTIONS}（先跑 build_question_bank.py）")
    with QUESTIONS.open(encoding="utf-8") as f:
        return json.load(f)


def pick_chapter(qs, chapter: str) -> list:
    """章节名做宽松包含匹配，省得你记全称。"""
    if not chapter:
        return qs
    hit = [q for q in qs if chapter in (q.get("chapter") or "")]
    if not hit:
        names = sorted({q.get("chapter") or "" for q in qs})
        sys.exit(f"没有章节名字含「{chapter}」。可选：\n  " + "\n  ".join(names))
    return hit


async def one(q, sem, done, total, mode, force):
    async with sem:
        t0 = time.time()
        cached = AI.get_cached(q["id"])
        if cached and not force and mode != "local":
            done[0] += 1
            print(f"[{done[0]:>4}/{total}] {q['id']} 跳过（已有缓存）", flush=True)
            return "skip"
        try:
            if mode == "local":
                obj = AI.normalize(AI.local_analysis(q), q)
                AI.put_cached(q["id"], obj, "local")
                tag = "local"
            else:
                raw = AI.chat(AI.build_messages(q))
                obj = AI.normalize(AI.parse_json_block(raw), q)
                AI.put_cached(q["id"], obj, "llm")
                tag = "llm"
            done[0] += 1
            print(f"[{done[0]:>4}/{total}] {q['id']} {tag:5} {time.time()-t0:5.1f}s "
                  f"{q['chapter'][:14]} {q['stem'][:26]}", flush=True)
            return "ok"
        except Exception as exc:
            done[0] += 1
            print(f"[{done[0]:>4}/{total}] {q['id']} 失败：{str(exc)[:160]}", flush=True)
            return "fail"


async def run(qs, mode: str, force: bool):
    conc = AI.ENV["concurrency"]
    sem = asyncio.Semaphore(conc)
    done = [0]
    total = len(qs)
    print(f"共 {total} 题，并发 {conc}，模型 {AI.ENV['model']}，"
          f"Key {'已配置' if AI.ENV['configured'] else '未配置（将只做本地推导）'}",
          flush=True)
    results = await asyncio.gather(
        *[one(q, sem, done, total, mode, force) for q in qs])
    ok = results.count("ok")
    skip = results.count("skip")
    fail = results.count("fail")
    print(f"\n完成：生成 {ok} / 跳过 {skip} / 失败 {fail}；"
          f"缓存条数 {len(AI.read_cache())}", flush=True)


def write_into_questions():
    """把 sidecar 里的解析焊进 questions.json（做备份，原子写）。"""
    cache = AI.read_cache()
    if not cache:
        sys.exit("缓存是空的，没什么可写。")
    qs = load_questions()
    hit = 0
    for q in qs:
        e = cache.get(q.get("id"))
        if not e:
            continue
        om = q.setdefault("obsidian_match", {})
        om["targeted_analysis"] = {
            "key_point": e.get("key_point", ""),
            "distractor_analysis": e.get("distractor_analysis") or {},
            "pitfall_summary": e.get("pitfall_summary", ""),
            "source": e.get("source", ""),
            "generated": e.get("generated", 0),
        }
        m = e.get("option_matrix") or {}
        if m:
            om["option_matrix"] = {k: v for k, v in m.items() if v}
            if e.get("source") == "llm":
                om["option_matrix_ai"] = True
        hit += 1
    backup = QUESTIONS.with_suffix(".json.bak")
    backup.write_bytes(QUESTIONS.read_bytes())
    tmp = QUESTIONS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(qs, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(QUESTIONS)
    print(f"已把 {hit} 条靶向解析写入 {QUESTIONS.name}（旧文件备份为 {backup.name}）",
          flush=True)


def main():
    ap = argparse.ArgumentParser(description="批量生成靶向破题精析")
    ap.add_argument("--chapter", default="", help="章节名（宽松包含匹配）")
    ap.add_argument("--all", action="store_true", help="全库")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少题")
    ap.add_argument("--local", action="store_true", help="不调模型，只写本地兜底")
    ap.add_argument("--force", action="store_true", help="已有缓存也重生成")
    ap.add_argument("--write", action="store_true", help="把缓存焊进 questions.json")
    args = ap.parse_args()

    if args.write:
        write_into_questions()
        return

    qs = load_questions()
    if not args.all:
        if not args.chapter:
            sys.exit("要么给 --chapter，要么加 --all（想看章节名就先随便给个错的）")
        qs = pick_chapter(qs, args.chapter)
    if args.limit:
        qs = qs[:args.limit]
    if not qs:
        sys.exit("没有题目可处理。")

    mode = "local" if (args.local or not AI.ENV["configured"]) else "llm"
    if mode == "local" and not args.local:
        print("提示：没配置 API Key，自动切到本地推导模式。", flush=True)
    try:
        asyncio.run(run(qs, mode, args.force))
    except KeyboardInterrupt:
        print("\n已中断，已生成的都落盘了，下次会跳过。", flush=True)


if __name__ == "__main__":
    main()
