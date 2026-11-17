// 题干「捉虫」：把三类词从普通文字里挑出来，交给前端上色。
// 为什么不用 dangerouslySetInnerHTML：题干里有用户可能粘贴的任意文字，
// 拼 HTML 容易出注入；这里返回 React 节点的数组，天然安全。

const NEG = [
  "不属于", "不正确", "错误的", "错误的是", "不包括", "不符合", "无关的",
  "不出现", "不可能", "不宜", "除外", "不位于", "不通过", "不发生",
  "不应", "有误", "不正确的是", "不是", "不能",
];

// 解剖方位词：只收 2 字以上的组合。「前/后/内/外」单字出现太频繁，
// 全标会把题干刷成一片黄，反而看不出重点。
const DIR = [
  "前内侧", "后外侧", "前外侧", "后内侧", "内上方", "外下方",
  "内侧", "外侧", "前方", "后方", "上方", "下方", "左侧", "右侧",
  "前缘", "后缘", "上缘", "下缘", "内面", "外面", "前面", "后面",
  "上端", "下端", "前端", "后端", "浅层", "深层", "近端", "远端",
  "近侧", "远侧", "左半", "右半", "左肺", "右肺", "左肾", "右肾", "浅面", "深面",
];

// 微观层级词：组胚题里出现频率极高，且和「光镜/电镜」直接决定答案
const MICRO = [
  "光镜下", "电镜下", "光镜", "电镜", "HE染色", "苏木精", "伊红",
  "PAS染色", "银染", "油镜", "高倍镜", "低倍镜", "冰冻切片",
];

const KIND = [
  ["neg", NEG],
  ["dir", DIR],
  ["micro", MICRO],
];

// 长词优先，避免「前内侧」被「内侧」先吃掉半截
const ALL = KIND.flatMap(([k, ws]) => ws.map((w) => [w, k]))
  .sort((a, b) => b[0].length - a[0].length);

const PATTERN = new RegExp(ALL.map(([w]) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
const LOOKUP = new Map(ALL);

export const CATEGORY_LABEL = {
  neg: "否定词",
  dir: "方位词",
  micro: "微观层级",
};

/** 把题干切成 [{text, kind}] 片段，kind 为空表示普通文字。 */
export function segments(text) {
  if (!text) return [];
  const out = [];
  let last = 0;
  PATTERN.lastIndex = 0;
  let m;
  while ((m = PATTERN.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: null });
    out.push({ text: m[0], kind: LOOKUP.get(m[0]) || null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: null });
  return out;
}

/** 统计题干里各类词的数量，用于抽屉顶部的「本题有 2 个否定词」提示。 */
export function counts(text) {
  const acc = { neg: 0, dir: 0, micro: 0 };
  for (const s of segments(text)) {
    if (s.kind) acc[s.kind] += 1;
  }
  return acc;
}
