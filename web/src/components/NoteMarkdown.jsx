import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { splitBlocks, splitChain } from "../lib/md";

/**
 * 笔记正文渲染器
 *
 * 与普通 <ReactMarkdown> 的区别只有一处：遇到 $$...$$ 块级公式时，
 * 先看它是不是一条「解剖结构 → 毗邻 → 临床」的长推导链；是的话改画成
 * 可换行的胶囊流程条（KaTeX 在窄卡片里会把 \text{中文} 撑出去），
 * 不是就交给 KaTeX 正常排版，外面套一层可横向滚动的卡片。
 */
function NoteMath({ body }) {
  const chain = useMemo(() => splitChain(body), [body]);
  const asChain = useMemo(() => !!chain && /\\text\{/.test(body), [chain, body]);

  if (asChain) {
    return (
      <div className="chain-flow" data-chain="1">
        {chain.nodes.map((n, i) => (
          <span key={i} className="chain-node">
            {i > 0 && <span className="chain-arrow">{chain.glyph}</span>}
            <span className="chain-chip">{n}</span>
          </span>
        ))}
      </div>
    );
  }

  // 普通公式：借 ReactMarkdown + remarkMath 渲染，拿到 .katex-display
  //
  // 两边必须各留一个空行：remark-math 只在 `$$` 独占一行、且前后是块边界时
  // 才给 display 模式。实测有题（anat_1098）数据里就是 `$$\text{...}\begin{cases}...`
  // 紧贴着的，不给换行就降级成行内 .katex，表格排版会散架。
  const md = `\n$$\n${body.trim()}\n$$\n`;
  return (
    <div className="math-block" data-math="1">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}>
        {md}
      </ReactMarkdown>
    </div>
  );
}

function NoteMarkdown({ text, className = "prose-note" }) {
  const parts = useMemo(() => splitBlocks(text), [text]);

  return (
    <div className={className} data-note-md="1">
      {parts.map((p, i) =>
        p.kind === "math" ? (
          <NoteMath key={i} body={p.body} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
          >
            {p.text}
          </ReactMarkdown>
        )
      )}
    </div>
  );
}

export default memo(NoteMarkdown);
