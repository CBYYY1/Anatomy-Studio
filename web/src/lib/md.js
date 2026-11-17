/**
 * Obsidian 原文里混着 wiki 语法，react-markdown 不认识：
 *   ![[raw/attachments/a/b.jpg]]      → 内联图片（走后端 /api/obsidian-media 代理）
 *   ![[raw/attachments/a/b.jpg|300]]  → 同上（丢掉尺寸参数）
 *   [[wiki/concepts/x/014_骨膜|骨膜]] → 骨膜
 *   [[wiki/concepts/x/014_骨膜]]      → 014_骨膜
 * 只在渲染前做纯文本替换，不拼 HTML，保持无注入风险。
 */

const MEDIA = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function encodePath(p) {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function mediaUrl(rel) {
  return `/api/obsidian-media?path=${encodeURIComponent(rel)}`;
}

export function prepNote(text) {
  if (!text) return "";
  let out = String(text);

  // 1) 嵌入（图片）
  out = out.replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (whole, target) => {
    const p = target.trim();
    if (!MEDIA.test(p)) return whole; // 非图片嵌入（如章节引用）原样保留
    return `![${p.split("/").pop()}](${mediaUrl(p)})`;
  });

  // 2) 嵌入（标准 markdown 本地图片）→ 走代理
  out = out.replace(/!\[([^\]]*)\]\((?!https?:|\/api\/)([^)]+)\)/g, (whole, alt, target) => {
    const p = decodeURI(target.trim());
    if (!MEDIA.test(p)) return whole;
    return `![${alt}](${mediaUrl(p)})`;
  });

  // 3) 双链 → 纯文本
  out = out.replace(/\[\[([^\]|]+?)\|([^\]]+)\]\]/g, (_, _t, label) => label);
  out = out.replace(/\[\[([^\]|]+?)\]\]/g, (_, target) => {
    const p = target.trim();
    return p.split("/").pop().replace(MEDIA, "");
  });

  // 4) 修 LaTeX 间距命令被 markdown 吃掉的问题
  out = repairLatex(out);

  return out;
}

/** 推导箭头：笔记里最常用 \;\Longrightarrow\; 串起一条因果链。 */
const ARROW = /\\(Longleftrightarrow|Longrightarrow|longrightarrow|Rightarrow|rightarrow|leftrightarrow|to)(?![A-Za-z])/;

/** 把数学块里「;⟹」这种被 markdown 转义吃掉的间距补回去。
 *
 * CommonMark 规定反斜杠只对 ASCII 标点做转义，`\;` 正好命中 —— 于是
 * 本该是「一个粗间距」的 `\;` 被渲染成一个裸分号。数据本身是好的
 * （questions.json 里 90 道题、167 个 $$...$$ 块的反斜杠都完整），
 * 所以只需要在送进 KaTeX 之前把裸分号还原成 `\;`。
 */
export function repairLatex(math) {
  return String(math)
    .replace(/(^|[^\\]);(\s*)\\(?=(Longleftrightarrow|Longrightarrow|longrightarrow|Rightarrow|rightarrow|leftrightarrow|to)\b)/g,
      "$1\\;$2\\")
    .replace(/\\(Longleftrightarrow|Longrightarrow|longrightarrow|Rightarrow|rightarrow|leftrightarrow|to)(\s*);/g,
      "\\$1$2\\;");
}

/** 把 `\text{中文}` / `\mathrm{x}` 之类脱成纯文本，用于链节点与摘要。 */
export function unTex(n) {
  return String(n || "")
    .replace(/\\(?:text|textbf|mathrm|mathbf|operatorname|mbox)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\[,;:! ]/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把一段推导链 `\text{A} \;\Longrightarrow\; \text{B}` 拆成节点。 */
export function splitChain(body) {
  const src = String(body || "");
  const arrow = new RegExp(ARROW.source, "g");
  const nodes = [];
  let last = 0;
  let m;
  while ((m = arrow.exec(src))) {
    nodes.push(src.slice(last, m.index));
    last = arrow.lastIndex;
  }
  nodes.push(src.slice(last));
  const cleaned = nodes.map(unTex).filter(Boolean);
  if (cleaned.length < 3) return null;      // 至少三段才算「链」
  const glyph = /Long|Rightarrow/.test(src) ? "⟹" : "→";
  return { nodes: cleaned, glyph };
}

/** 长推导链是否该改画成胶囊流程条（否则交给 KaTeX 正常渲染）。 */
export function isChain(body) {
  const src = String(body || "");
  const arrows = (src.match(new RegExp(ARROW.source, "g")) || []).length;
  if (arrows < 2) return false;
  const plain = src.replace(/\\text\{([^}]*)\}/g, "$1").replace(/\\[;,:]/g, "").replace(/\s+/g, "");
  return plain.length >= 24;
}

/** 把正文按 $$...$$ 切成「markdown 段 / 数学段」。 */
export function splitBlocks(text) {
  const src = String(text || "");
  const out = [];
  const re = /\$\$([\s\S]*?)\$\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: "md", text: src.slice(last, m.index) });
    out.push({ kind: "math", body: repairLatex(m[1]) });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ kind: "md", text: src.slice(last) });
  return out;
}
