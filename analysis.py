"""AI 靶向破题解析（RAG 双轨解析的「第一轨」）

设计要点
--------
* **事实锚点来自用户自己的 Obsidian 笔记**：把 `raw_markdown_context`（原文）、
  `option_matrix`（每个选项在笔记里的定义）、`heading`/`matched_note`（出处）
  一起塞进 prompt，模型负责「拿你的笔记给你讲题」，而不是自由发挥。
* **缓存落在 data/targeted_analysis.json（sidecar），不直接写 questions.json**：
  questions.json 有 8.5 MB，每生成一题就整文件重写要约 1.5–2 s，批量预生成
  300 题会白烧十几分钟磁盘 IO。sidecar 只有几十 KB，写入约 2 ms；读取时由
  `/api/questions/{id}` 合并回题目。需要把结果永久焊进 questions.json 时，
  跑 `python batch_analyze.py --write`。
* **没有 API Key 也能用**：退回「本地推导」——直接用笔记里的定义拼出破题眼与
  干扰项排雷，界面上明确标注「本地推导 · 未调用大模型」，绝不假装是 AI 写的。
* 两套 prompt：系统解剖学重「空间/毗邻/走行」，组织胚胎学重「层次/染色/超微
  结构/发生来源」。按 module + chapter 关键词自动选。
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit


def _base_dir() -> Path:
    """可写根目录：打包后跟 config.py 一样认 .exe 所在目录（见 config.base_dir）。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


HERE = _base_dir()
DATA = HERE / "data"
CACHE = DATA / "targeted_analysis.json"

LETTERS = ["A", "B", "C", "D", "E", "F"]

# ---------------------------------------------------------------- .env

# ---------------------------------------------------------------- 配置来源

_ENV_KEYS = {
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    "ANALYZE_CONCURRENCY", "ANALYZE_TIMEOUT",
}


def _env_file() -> dict:
    """老式 .env 仍然认（自己那台机器不用重填），但优先级低于用户配置。"""
    out = {}
    env_path = HERE / ".env"
    if env_path.exists():
        try:
            for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k in _ENV_KEYS:
                    out[k] = v
        except Exception:
            pass
    return out


class _EnvView(dict):
    """动态配置视图。

    以前这里是模块级常量 `ENV = load_env()`，改一次 Key 得重启进程。
    共享版要在「设置」页面里即时生效，所以改成每次取值都问 config 模块
    （它自带 mtime 缓存，开销可忽略）。
    """

    def _refresh(self):
        import config as CFG
        llm = CFG.llm()
        dotenv = _env_file()
        key = (llm.get("api_key") or "").strip() or os.environ.get("DEEPSEEK_API_KEY") \
            or dotenv.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        base = (llm.get("base_url") or "").strip() \
            or os.environ.get("DEEPSEEK_BASE_URL") or dotenv.get("DEEPSEEK_BASE_URL") \
            or os.environ.get("OPENAI_BASE_URL") or "https://api.deepseek.com"
        model = (llm.get("model") or "").strip() \
            or os.environ.get("DEEPSEEK_MODEL") or dotenv.get("DEEPSEEK_MODEL") \
            or "deepseek-chat"
        try:
            conc = max(1, int(os.environ.get("ANALYZE_CONCURRENCY") or 4))
        except ValueError:
            conc = 4
        try:
            timeout = float(os.environ.get("ANALYZE_TIMEOUT") or 90)
        except ValueError:
            timeout = 90
        try:
            max_tokens = max(600, int(os.environ.get("ANALYZE_MAX_TOKENS") or 3200))
        except ValueError:
            max_tokens = 3200
        dict.update(self, {
            "key": key, "base": base.rstrip("/"), "model": model,
            "concurrency": conc, "timeout": timeout, "max_tokens": max_tokens,
            # 本地 Ollama 不需要 Key：只要 base_url 指向 localhost 就当作已配置
            "configured": bool(key) or (llm.get("provider") == "ollama"),
            "style": (llm.get("style") or "rigorous"),
            "provider": (llm.get("provider") or "deepseek"),
        })

    def __getitem__(self, k):
        self._refresh()
        return dict.__getitem__(self, k)

    def get(self, k, default=None):
        self._refresh()
        return dict.get(self, k, default)

    def __contains__(self, k):
        self._refresh()
        return dict.__contains__(self, k)

    def items(self):
        self._refresh()
        return dict.items(self)


ENV = _EnvView()


def load_env() -> dict:
    """保留旧接口（batch_analyze.py 仍在用），等价于读一次当前配置。"""
    ENV._refresh()
    return dict(ENV)


# ---------------------------------------------------------------- prompt

SCHEMA_HINT = """请严格输出单个 JSON 对象，不要加 markdown 代码块、不要加任何解释文字：
{
  "key_point": "一句话点破：题干问的是什么限定条件，为什么正确答案正好满足它",
  "distractor_analysis": { "错误选项字母": "为什么这个选项错 / 偷换了哪个概念" },
  "pitfall_summary": "一句考场避坑提醒或极简对比口诀",
  "option_matrix": {
    "A": "【选项名】用标准医学定义写清它的归属、支配/血供/毗邻、走向或功能，再点一句它与本题设问的关系（正确的写明「故 A 为本题正确答案」）",
    "B": "【选项名】同上",
    "C": "【选项名】同上",
    "D": "【选项名】同上",
    "E": "【选项名】同上"
  }
}
distractor_analysis 只需包含错误选项（答案是 A、C 时，就只写 B、D、E）。
option_matrix 必须覆盖**每一个选项**（A、B、C、D、E 全部），用你自己的标准医学知识写，不要复述笔记原文、不要写「笔记未提及」之类的话。"""

SYS_ANATOMY = """你是一位严谨的医学院《系统解剖学》教授，正在给学生做一对一的错题剖析。

事实优先级（严格执行）：
1. 【用户的 Obsidian 课堂笔记原文】最高优先。笔记里的表述、层次划分、左右与毗邻关系就是唯一标准。
2. 笔记没覆盖的干扰项，才用标准人卫版《系统解剖学》知识排错，并明确写「笔记未收录」。
3. 绝不允许编造笔记里没有的页码、数字或结构名。

剖析纪律（这是本任务的重点）：
- 解剖题的错误几乎都是这几类，判断时对号入座并点明：
  ① 毗邻关系张冠李戴（把 A 结构的前方写成后方、内侧写成外侧）；
  ② 左右/上下/前后方位颠倒；
  ③ 层级混淆（把「器官」与「器官的某一部分」当同层，如股骨颈 vs 股骨体）；
  ④ 同名不同物（棘间韧带 vs 棘上韧带、上泌涎核 vs 下泌涎核）；
  ⑤ 走行/分支错误（血管神经的起源、行程、分支顺序被调换）。
- 「为什么对」要落到题干的限定词上：题眼往往是「最」「位于」「毗邻」「穿过」「由…发出」「损伤后出现」这些抓手。
- 每个干扰项只写 1–2 句，直接说「它描述的是谁」或「它错在哪个方向/层级」，不要复述教材大段。

语言：简体中文、总分结构、不写客套话。"""

SYS_HISTO = """你是一位严谨的医学院《组织胚胎学》教授，正在给学生做一对一的错题剖析。

事实优先级（严格执行）：
1. 【用户的 Obsidian 课堂笔记原文】最高优先：层次划分、细胞名称、染色结果以笔记为准。
2. 笔记没覆盖的干扰项，才用标准人卫版《组织胚胎学》知识排错，并注明「笔记未收录」。
3. 不许编造笔记里没有的染色颜色、放大倍数或胚龄数字。

剖析纪律（这是本任务的重点）：
- 组胚题的错误集中在五类，判断时点明属于哪一类：
  ① 观察尺度错位（光镜能看到的说成电镜才能看到，或反之）；
  ② 染色性质颠倒（HE 的嗜酸/嗜碱、PAS 阳性/阴性、银染亲和性）；
  ③ 层次或位置错位（把某结构放进错误的层，如把骨骼肌说成黏膜下层）；
  ④ 发生来源错误（外/中/内三个胚层来源被调换，或神经嵴来源被漏掉）；
  ⑤ 时序错误（胚胎发生先后、结构退化与消失的时间点）。
- 「为什么对」要落到题干限定词上：光镜下/电镜下、HE 染色、来源于、由…发育而来、先后顺序。

语言：简体中文、总分结构、不写客套话。"""

SYS_MNEMONIC = """你是一位很会把解剖学讲得记住的医学院老师，正在给学生做错题剖析。

事实优先级（严格执行）：
1. 【用户的 Obsidian 课堂笔记原文】最高优先，是唯一事实标准。
2. 笔记没覆盖的干扰项，才补标准人卫版知识，并注明「笔记未收录」。
3. 绝不编造笔记里没有的页码、数字或结构名。

表达风格（这是本任务的重点）：
- 多用**口诀、对比、身体位置联想**，例如「前胃后胰左脾右肝」这类压缩句。
- 干扰项排雷写成「B 说的是谁 → 一句话对照」，能对比就对比，能押韵就押韵。
- 允许适度口语（「记住这个」），但每个结论仍要能落到笔记原句上。

语言：简体中文，短句，不写客套话。"""

_HISTO_HINTS = ("组织", "胚胎", "基本组织", "上皮", "结缔", "肌组织", "神经组织", "血液")


def pick_system(q) -> str:
    """按学科选 prompt 底稿，再按用户在设置里选的风格替换表达要求。

    - 严谨教材风（rigorous）：默认，落到人卫版标准定义；
    - 通俗助记风（mnemonic）：换成口诀/对比表风格，事实锚点不变。
    """
    blob = f"{q.get('module', '')}{q.get('chapter', '')}"
    base = SYS_HISTO if any(h in blob for h in _HISTO_HINTS) else SYS_ANATOMY
    try:
        style = ENV.get("style") or "rigorous"
    except Exception:
        style = "rigorous"
    if style != "mnemonic":
        return base
    # 助记风：保留「事实优先级」段（那是纪律，不能松），只替换表达要求
    head = base.split("事实优先级")[0]
    facts = "事实优先级" + base.split("事实优先级", 1)[1].split("剖析纪律")[0] \
        if "剖析纪律" in base else ""
    return f"""{head}{facts}表达风格（本任务重点）：
- 先给一句能背下来的口诀或极简对比，再解释。
- 干扰项排雷写成「X 说的是谁 → 一句话对照」，能对比就对比。
- 允许适度口语，但每个结论都要能落回笔记原句。

语言：简体中文，短句，不写客套话。"""


def build_messages(q) -> list:
    om = q.get("obsidian_match") or {}
    opts = q.get("options") or {}
    keys = sorted(opts)
    ans = [k for k in (q.get("answer") or []) if k in opts]
    matrix = om.get("option_matrix") or {}

    opt_lines = []
    for k in keys:
        tag = "（正确答案）" if k in ans else ""
        opt_lines.append(f"{k}. {opts[k]}{tag}")

    note = (om.get("raw_markdown_context") or "").strip()
    if len(note) > 2600:
        note = note[:2600] + "\n…（笔记原文后略）"

    user = f"""【题目】{q.get('stem', '')}
【题型】{'多选题（答案不止一个）' if q.get('type') == 'multiple' else '单选题'}
【章节】{q.get('chapter', '')}
【选项】
{chr(10).join(opt_lines)}
【标准答案】{'、'.join(ans) or '（缺）'}

【用户 Obsidian 笔记出处】{om.get('matched_note', '')} › {om.get('heading', '')}
【笔记原文（用作破题眼与干扰项排雷的事实锚点）】
{note or '（这道题没有匹配到笔记正文）'}

请基于以上材料，针对这道题的设问角度做靶向剖析。
其中 option_matrix 请完全用你自己的标准医学知识（人卫版教材口径）为每个选项写百科式剖析，
不要照抄笔记原文，也不要写「笔记未提及/未收录」这类话。

{SCHEMA_HINT}"""
    return [{"role": "system", "content": pick_system(q)},
            {"role": "user", "content": user}]


# ---------------------------------------------------------------- 本地兜底

_MD_BOLD = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_MD_CODE = re.compile(r"`([^`]*)`")
_MD_WIKI = re.compile(r"\[\[([^\]|]+?)\|([^\]]*)\]\]")
_MD_LINK = re.compile(r"!?\[\[([^\]]+?)\]\]")


def _plain(s):
    """把笔记原文里的 markdown 记号抹掉，好塞进一句话里读。"""
    s = s or ""
    s = _MD_WIKI.sub(lambda m: m.group(2) or m.group(1), s)
    s = _MD_LINK.sub(lambda m: m.group(1), s)
    s = _MD_BOLD.sub(lambda m: m.group(1) or m.group(2), s)
    s = _MD_CODE.sub(r"\1", s)
    s = re.sub(r"(?:^|[\s（(])>[>*\s]*", " ", s, flags=re.M)
    s = re.sub(r"^[\s>*\-|]+", "", s, flags=re.M)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _ask(stem):
    """临床病例题题干很长，真正被问的是最后一句（「肾移动的方向可能是」）。"""
    parts = [p.strip() for p in re.split(r"[。？！]", stem or "") if p.strip()]
    if not parts:
        return ""
    for p in reversed(parts):
        if len(p) >= 6 and not p.endswith("的"):
            return p
    return parts[-1]


def _clip(s, n=90):
    s = _plain(s)
    if len(s) <= n:
        return s
    cut = s[:n]
    for p in ("。", "；", "，", "、"):
        i = cut.rfind(p)
        if i > n * 0.45:
            return cut[:i + 1]
    return cut + "…"


_DIRISH_CHARS = set("内外上下前后左右侧方向端部正中内上外下圆椭圆三角菱形梭方不规则梨锥柱漏斗半月上大中小深浅")


def local_analysis(q) -> dict:
    """没配 API Key 时的本地推导：只搬笔记里的事实，不编造。"""
    om = q.get("obsidian_match") or {}
    opts = q.get("options") or {}
    keys = sorted(opts)
    ans = [k for k in (q.get("answer") or []) if k in opts]
    matrix = om.get("option_matrix") or {}
    ans_text = "、".join(f"{k}「{opts[k]}」" for k in ans) or "（缺答案）"

    anchor = ""
    for k in ans:
        if matrix.get(k):
            anchor = _clip(matrix[k], 120)
            break
    if not anchor:
        anchor = _clip(om.get("raw_markdown_context") or "", 120)

    ask = _ask(q.get("stem", "")) or _clip(q.get("stem", ""), 46)
    key_point = f"这道题问的是「{ask}」，答案 {ans_text}。"
    if anchor:
        key_point += f"笔记里的依据：{anchor}"

    def opt_kind(text):
        """判断选项是哪一类「非名词」描述：方位 / 形状 / 名词。"""
        t = re.sub(r"[\s，。、]", "", text or "")
        if not t or len(t) > 6:
            return ""
        if t.endswith("形"):
            return "shape"
        if (t.startswith("向") or t.endswith(("侧", "方"))) and set(t) <= _DIRISH_CHARS:
            return "dir"
        return ""

    distractors = {}
    for k in keys:
        if k in ans:
            continue
        text = _clip(opts[k], 30)
        kind = opt_kind(text)
        if matrix.get(k):
            distractors[k] = f"不选 {k}「{text}」——笔记里它指的是：{_clip(matrix[k], 96)}"
        elif kind == "dir":
            distractors[k] = (f"不选 {k}「{text}」——这是方位描述，不是结构名；"
                              f"回笔记里看它给出的方位，与「{ask}」对得上的是 {ans_text}。")
        elif kind == "shape":
            distractors[k] = (f"不选 {k}「{text}」——这是形状描述；"
                              f"笔记里对「{ask}」的形态写得很直接，应为 {ans_text}。")
        else:
            distractors[k] = (f"不选 {k}「{text}」——笔记没有单独给「{text}」下定义；"
                              f"对照上面那段笔记与「{ask}」的对应关系，结论是 {ans_text}。")

    kws = [w for w in (q.get("keywords") or []) if w][:3]
    pitfall = ("先圈出题干的限定词再比对选项"
               + (f"；本题抓手：{'、'.join(kws)}" if kws else "")
               + "。同名结构只差一个方位词时，优先核对左右与层级。")

    # 本地矩阵：只把题库里已有的定义收拾干净，正确项补一句结论；没有定义就留空给前端提示去配 Key
    lmatrix = {}
    for k in keys:
        body = _clip(matrix.get(k) or "", 150)
        if not body:
            continue
        body = f"【{_clip(opts[k], 18)}】{body}"
        if k in ans:
            body += f" 故 {k} 为本题正确答案。"
        lmatrix[k] = body

    out = {"key_point": key_point, "distractor_analysis": distractors,
           "pitfall_summary": pitfall}
    if lmatrix:
        out["option_matrix"] = lmatrix
    return out


# ---------------------------------------------------------------- 缓存

_cache_lock = Lock()


def read_cache() -> dict:
    if not CACHE.exists():
        return {}
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_cached(qid: str):
    e = read_cache().get(qid)
    if not e:
        return None
    return e if isinstance(e, dict) and e.get("key_point") else None


def put_cached(qid: str, analysis: dict, source: str):
    """原子落盘：临时文件 + os.replace，避免写坏整份缓存。"""
    analysis = dict(analysis)
    analysis["source"] = source
    analysis["generated"] = int(time.time())
    with _cache_lock:
        data = read_cache()
        data[qid] = analysis
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True),
                       encoding="utf-8")
        os.replace(tmp, CACHE)
    return analysis


# ---------------------------------------------------------------- 解析模型输出

_FENCE = re.compile(r"```(?:json)?", re.I)


def _repair_json(body: str) -> str:
    """补全被截断的 JSON：闭上未结束的字符串、清掉悬空逗号、补齐括号。

    踩过的坑：max_tokens 给小了时模型会在 `"key_point": "……` 中间被
    硬切，`rfind("}")` 找不到右括号，整次生成白费。
    """
    stack, in_str, esc = [], False, False
    for ch in body:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch in "}]":
            if stack:
                stack.pop()
    out = body + ('"' if in_str else "")
    out = re.sub(r"[,\s]*$", "", out)
    # 悬空的 `"B":`（有键无值）直接砍掉
    out = re.sub(r',\s*"[A-Z]"?\s*:\s*$', "", out)
    return out + "".join(reversed(stack))


def parse_json_block(text: str) -> dict:
    """从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话、尾逗号、被截断）。"""
    t = _FENCE.sub("", (text or "").strip())
    start, end = t.find("{"), t.rfind("}")
    if start < 0:
        raise ValueError("模型没有返回 JSON 对象")
    if end > start:
        body = t[start:end + 1]
        for candidate in (body, re.sub(r",\s*([}\]])", r"\1", body)):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
    # 走到这里说明输出被截断或格式坏：尝试修好再用
    fixed = _repair_json(t[start:])
    try:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", fixed))
    except json.JSONDecodeError as exc:
        raise ValueError(f"模型返回的 JSON 无法解析（输出可能被截断）：{exc}") from exc


def normalize(obj: dict, q) -> dict:
    opts = q.get("options") or {}
    ans = set(q.get("answer") or [])
    da = obj.get("distractor_analysis") or {}
    if isinstance(da, list):                       # 模型偶尔给数组
        da = {str(i): v for i, v in enumerate(da)}
    clean = {}
    for k, v in da.items():
        kk = str(k).strip().upper()[:1]
        if kk in opts and kk not in ans and isinstance(v, str) and v.strip():
            clean[kk] = v.strip()

    # option_matrix：A–E 每个选项都要有，只保留真实存在的选项字母
    raw_m = obj.get("option_matrix") or {}
    if isinstance(raw_m, list):                    # 模型偶尔给数组
        raw_m = {LETTERS[i]: v for i, v in enumerate(raw_m) if i < len(LETTERS)}
    matrix = {}
    if isinstance(raw_m, dict):
        for k, v in raw_m.items():
            kk = str(k).strip().upper()[:1]
            if kk in opts and isinstance(v, str) and v.strip():
                matrix[kk] = v.strip()

    out = {
        "key_point": str(obj.get("key_point") or "").strip(),
        "distractor_analysis": clean,
        "pitfall_summary": str(obj.get("pitfall_summary") or "").strip(),
    }
    if matrix:
        out["option_matrix"] = matrix
    if not out["key_point"]:
        raise ValueError("模型返回缺少 key_point")
    return out


# ---------------------------------------------------------------- LLM 调用

def _headers():
    return {"Authorization": f"Bearer {ENV['key']}",
            "Content-Type": "application/json"}


def _payload(messages, stream=False):
    return {
        "model": ENV["model"],
        "messages": messages,
        "temperature": 0.25,
        "max_tokens": ENV["max_tokens"],
        "stream": stream,
    }


def _is_local_url(base: str) -> bool:
    """是不是本机 / 内网地址（这类请求必须绕过系统代理）。

    踩过的坑：Windows 开着 Clash 之类的全局代理时，httpx 会把
    http://localhost:11434 也丢给 127.0.0.1:7897，结果拿到 502。
    """
    try:
        host = (urlsplit(base).hostname or "").lower()
    except Exception:
        return False
    if host in ("localhost", "::1", "0.0.0.0", "127.0.0.1"):
        return True
    if host.startswith("127.") or host.startswith("10."):
        return True
    if host.startswith("192.168."):
        return True
    m = re.match(r"^172\.(\d{1,3})\.", host)
    return bool(m and 16 <= int(m.group(1)) <= 31)


def client_kwargs(base: str, timeout) -> dict:
    """httpx.Client / AsyncClient 的公共参数：内网地址关掉环境代理。"""
    kw = {"timeout": timeout}
    if _is_local_url(base):
        kw["trust_env"] = False
    return kw


def chat(messages) -> str:
    """同步调用（供普通 POST 接口用）。"""
    import httpx
    url = f"{ENV['base']}/chat/completions"
    with httpx.Client(**client_kwargs(ENV["base"], ENV["timeout"])) as cli:
        r = cli.post(url, headers=_headers(), json=_payload(messages))
        if r.status_code >= 400:
            raise RuntimeError(f"模型接口 {r.status_code}：{r.text[:300]}")
        data = r.json()
    return data["choices"][0]["message"]["content"]


async def chat_stream(messages):
    """异步流式：逐段 yield 增量文本（SSE 转发给前端做打字机效果）。"""
    import httpx
    url = f"{ENV['base']}/chat/completions"
    async with httpx.AsyncClient(
            **client_kwargs(ENV["base"], ENV["timeout"])) as cli:
        async with cli.stream("POST", url, headers=_headers(),
                              json=_payload(messages, stream=True)) as r:
            if r.status_code >= 400:
                body = (await r.aread()).decode("utf-8", "replace")
                raise RuntimeError(f"模型接口 {r.status_code}：{body[:300]}")
            async for line in r.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    obj = json.loads(chunk)
                except json.JSONDecodeError:
                    continue
                for ch in obj.get("choices") or []:
                    piece = (ch.get("delta") or {}).get("content")
                    if piece:
                        yield piece


def analyze_sync(q, force=False):
    """返回 (analysis, source)，source ∈ {"cache","llm","local"}。"""
    if not force:
        hit = get_cached(q["id"])
        if hit:
            return hit, "cache"
    if ENV["configured"]:
        raw = chat(build_messages(q))
        obj = normalize(parse_json_block(raw), q)
        return put_cached(q["id"], obj, "llm"), "llm"
    return put_cached(q["id"], normalize(local_analysis(q), q), "local"), "local"
