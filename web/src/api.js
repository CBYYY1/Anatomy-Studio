// 与后端通讯的唯一出入口。所有请求默认走相对路径 /api，
// 开发时由 vite proxy 转发到 8788，生产时由 FastAPI 同源提供。

const J = { "Content-Type": "application/json" };

async function req(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || body.message || "";
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${detail}`.trim());
  }
  return res.json();
}

export const api = {
  meta: () => req("/api/meta"),
  questions: () => req("/api/questions"),
  question: (id) => req(`/api/questions/${encodeURIComponent(id)}`),
  knowledge: () => req("/api/knowledge"),

  progress: () => req("/api/progress"),
  answer: (payload) =>
    req("/api/progress/answer", {
      method: "POST",
      headers: J,
      body: JSON.stringify(payload),
    }),
  star: (id) =>
    req("/api/progress/star", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ id }),
    }),
  session: (payload) =>
    req("/api/progress/session", {
      method: "POST",
      headers: J,
      body: JSON.stringify(payload),
    }),
  reset: () => req("/api/progress/reset", { method: "POST" }),

  cram: async (n = 0) => {
    try {
      return await req(`/api/cram?n=${n}`);
    } catch {
      const fallbackN = n > 0 && n <= 100 ? n : 100;
      return await req(`/api/cram?n=${fallbackN}`);
    }
  },
  search: (q, limit = 24) =>
    req(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  note: (path) => req(`/api/obsidian-note?path=${encodeURIComponent(path)}`),
  link: (path) => req(`/api/obsidian-link?path=${encodeURIComponent(path)}`),
  markError: (payload) =>
    req("/api/mark-error", {
      method: "POST",
      headers: J,
      body: JSON.stringify(payload),
    }),

  // 靶向破题解析：默认吃缓存，force 才重新问模型
  analyzeStatus: () => req("/api/analyze/status"),
  analyze: (id, force = false) =>
    req(`/api/questions/${encodeURIComponent(id)}/analyze`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ force }),
    }),

  // ---- 设置中心
  settings: (reveal = false) => req(`/api/settings?reveal=${reveal ? 1 : 0}`),
  putSettings: (patch) =>
    req("/api/settings", { method: "PUT", headers: J, body: JSON.stringify(patch) }),
  testLlm: (payload) =>
    req("/api/settings/test-llm", { method: "POST", headers: J, body: JSON.stringify(payload) }),
  // 实时拉取平台在线的模型列表（不写死模型名）
  fetchModels: (payload) =>
    req("/api/settings/fetch-models", { method: "POST", headers: J, body: JSON.stringify(payload) }),
  // 钉住 / 取消钉住常用模型胶囊
  pinModel: (model, pinned = true) =>
    req("/api/settings/pin-model", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ model, pinned }),
    }),
  verifyObsidian: (path) =>
    req("/api/settings/verify-obsidian", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ path }),
    }),
  clearKey: () =>
    req("/api/settings/clear-key", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ confirm: true }),
    }),

  // ---- 数据备份 / 题库热更新 / 重置
  exportProgress: () => "/api/data/export-progress",
  importProgress: (file) => upload("/api/data/import-progress", file),
  updateBank: (file) => upload("/api/data/update-question-bank", file),
  resetProgress: (confirm = true, scope = "all") =>
    req("/api/data/reset-progress", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ confirm, scope }),
    }),

  // ---- 云端热同步（GitHub）
  updaterMeta: () => req("/api/updater/meta"),
  updaterCheck: (fresh = false) => req(`/api/updater/check?fresh=${fresh ? 1 : 0}`),
  updaterStatus: () => req("/api/updater/status"),
  syncBank: () =>
    req("/api/updater/sync-bank", {
      method: "POST",
      headers: J,
      body: JSON.stringify({}),
    }),
  applyAppUpdate: (payload = {}) =>
    req("/api/updater/apply-app-update", {
      method: "POST",
      headers: J,
      body: JSON.stringify(payload),
    }),
  appUpdateStatus: () => req("/api/updater/app-update-status"),
};

/** multipart 上传：不要把 Content-Type 写死，交给浏览器带 boundary。 */
async function upload(path, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(path, { method: "POST", body: fd });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || body.message || "";
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${detail}`.trim());
  }
  return res.json();
}

// 图片走后端代理，保证库里带空格/中文的路径也能取到
export const mediaUrl = (rel) =>
  `/api/obsidian-media?path=${encodeURIComponent(rel)}`;
