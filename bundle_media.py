"""
把 Obsidian 库里的图谱/切片图片，拷进 studio/data/media，形成一个不依赖 Obsidian 的媒体包。

为什么需要它：使用者的电脑上未必有配套的 Obsidian 库。题干里引用的图片路径形如
    raw/attachments/人体结构学 第2版_assets/fig/图3-14_胃的形态和分部.jpg
如果只把 questions.json 发出去，这些图在「内置静态解析模式」下全是破图。
把图片按同样的相对路径铺到 data/media 下，后端 /api/obsidian-media 会优先读它。

用法：
    python bundle_media.py                 # 只拷 questions.json 里真正引用到的图
    python bundle_media.py --all           # 把库里所有图片都拷进来（体积大，约 1GB+）
    python bundle_media.py --dry           # 只报告会拷多少，不落盘
    python bundle_media.py --vault "D:\\Obsidian\\人体结构学"
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
MEDIA = DATA / "media"
QUESTIONS = DATA / "questions.json"
MODEL = DATA / "questions_model.json"
CONFIG = DATA / "user_config.json"

MEDIA_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def reconfigure_stdio() -> None:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def vault_from_config() -> str:
    """没给 --vault 时，从设置里找（user_config.json → 旧 config.json）。"""
    for p in (CONFIG, HERE / "config.json"):
        if not p.exists():
            continue
        try:
            raw = json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        kb = raw.get("knowledge_base") or {}
        v = kb.get("obsidian_vault_path") or raw.get("vault") or ""
        if v:
            return v
    return ""


def referenced_images() -> list[str]:
    """从题库里收集所有被引用的相对路径（obsidian_match.images 已经是相对路径）。"""
    seen: dict[str, None] = {}
    for f in (QUESTIONS, MODEL):
        if not f.exists():
            continue
        qs = json.loads(f.read_text(encoding="utf-8"))
        for q in qs:
            om = q.get("obsidian_match") or {}
            for rel in om.get("images") or []:
                rel = str(rel).replace("\\", "/").lstrip("/")
                if rel and rel not in seen:
                    seen[rel] = None
    return list(seen)


def all_vault_images(vault: Path) -> list[str]:
    out: list[str] = []
    skip = {".obsidian", ".check", ".git", ".trash"}
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in skip]
        rp = Path(root)
        for fn in files:
            if Path(fn).suffix.lower() in MEDIA_EXT:
                try:
                    rel = (rp / fn).relative_to(vault).as_posix()
                except ValueError:
                    continue
                out.append(rel)
    return out


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def main() -> int:
    reconfigure_stdio()
    ap = argparse.ArgumentParser(description="把 Obsidian 图谱打包进 data/media")
    ap.add_argument("--vault", default="", help="Obsidian 库根目录")
    ap.add_argument("--all", action="store_true", help="拷贝库里所有图片")
    ap.add_argument("--dry", action="store_true", help="只统计，不写文件")
    ap.add_argument("--force", action="store_true", help="已存在也重写")
    args = ap.parse_args()

    vault_str = args.vault or vault_from_config()
    if not vault_str:
        print("找不到 Obsidian 库路径。用 --vault 指定，或先在【设置 → 知识库】里填好。")
        return 1
    vault = Path(vault_str).expanduser()
    if not vault.is_dir():
        print(f"这个路径不是文件夹：{vault}")
        return 1

    rels = all_vault_images(vault) if args.all else referenced_images()
    if not rels:
        print("没有需要打包的图片（questions.json 里没有 images 字段？）")
        return 1

    print(f"Obsidian 库：{vault}")
    print(f"目标目录  ：{MEDIA}")
    print(f"待处理    ：{len(rels)} 个文件")
    if args.dry:
        missing = [r for r in rels if not (vault / r).is_file()]
        total = sum((vault / r).stat().st_size for r in rels if (vault / r).is_file())
        print(f"可拷贝    ：{len(rels) - len(missing)} 个，合计 {human(total)}")
        if missing:
            print(f"源文件缺失：{len(missing)} 个（前 5 个）")
            for m in missing[:5]:
                print(f"  - {m}")
        return 0

    MEDIA.mkdir(parents=True, exist_ok=True)
    copied = skipped = missing = 0
    total_bytes = 0
    for i, rel in enumerate(rels, 1):
        src = vault / rel
        dst = MEDIA / rel
        if not src.is_file():
            missing += 1
            continue
        if dst.exists() and not args.force:
            skipped += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        total_bytes += dst.stat().st_size
        copied += 1
        if i % 50 == 0 or i == len(rels):
            print(f"  [{i}/{len(rels)}] {copied} 新拷贝 / {skipped} 已存在 / {missing} 缺失", flush=True)

    print()
    print(f"完成：新拷贝 {copied}，已存在 {skipped}，源缺失 {missing}")
    print(f"本次写入 {human(total_bytes)}，媒体包总计 {human(sum(p.stat().st_size for p in MEDIA.rglob('*') if p.is_file()))}")
    print("提示：把 data/media 一起发出去，同学在内置模式下就能看到图谱了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
