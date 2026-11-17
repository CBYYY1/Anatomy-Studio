# Anatomy Studio · 人体结构学智能刷题与薄弱点分析

> 1917 道「解剖助手」真题 + 你自己的 Obsidian 笔记，逐题挂载证据。
> **双轨解析**：左轨 AI 靶向破题（拿着你的笔记讲题），右轨笔记原文溯源。
> 三套主题（深色 / 纯黑 OLED / 浅色）· 默认完全离线 · 数据不出本机。
> **可分发**：配置全部走界面（`Ctrl + ,` 设置中心），Key 与路径都不写死；没装 Obsidian 也能用内置模式。
> **免安装包**：`release\AnatomyStudio_Portable\`（72.6 MB，双击 bat 即用，不需要 Python / Node / Obsidian），压缩包 `AnatomyStudio_Portable.zip`（46.7 MB）。

---

## 零、免安装便携版

```
release/AnatomyStudio_Portable.zip        ← 46.7 MB，分发给使用者
```

同学解压后双击里面的 **`启动 Anatomy Studio.bat`**：黑窗口跑本地服务，1 秒后浏览器自动开
`http://127.0.0.1:18080/`（端口被占会自动顺延，以窗口里打印的为准）。关掉黑窗口即停止。

| 包里有什么 | 说明 |
| --- | --- |
| `AnatomyStudio.exe` | PyInstaller `-D` 打包的后端，5.5 MB，不需要装 Python |
| `_internal\` | 运行时依赖（fastapi / uvicorn / httpx…） |
| `dist\` | 前端构建产物，放在 exe 同级，将来换前端可以直接替换不用重打包 |
| `data\questions.json` | 1917 题，图片路径已重写成内置 `media/...` |
| `data\media\` | **196 张解剖图谱 / 切片**，从我的 Obsidian 库里抽出来的实体文件 |
| `data\user_config.json` | **彻底脱敏**：`api_key=""`、`mode="builtin"`、`obsidian_vault_path=""` |
| `data\user_progress.json` | 空进度，同学拿到是全新状态 |
| `使用说明_README.txt` | 给同学看的白话说明（中文 UTF-8） |

重新生成这个包（改完前端或题库之后）：

```powershell
cd anatomy-studio
python build_portable.py                # 全流程：npm build + 抽图 + 脱敏 + PyInstaller
python build_portable.py --skip-npm     # 只重打包（前端没改）
python build_portable.py --skip-npm --skip-pyi   # 只刷新 data/ 与 dist/，复用上次的 exe（约 3 秒）
```

脚本每一步都会打日志，最后一步是**安全自检**：全文扫描发布目录不得出现 `sk-` Key、扫描 exe/dll 二进制、
并比对开发目录两个个人文件的 sha256 —— **构建前后指纹必须一致**，否则说明你的 Key 或进度被动了。
（实测指纹：`user_config.json` 6647 B / `c7234fcc970d1f4f…`，`user_progress.json` 74 B / `b3644213a377faea…`。）

便携版与源码版的区别：
- 监听端口 **18080**（源码版 8788），frozen 时自动 `_free_port()` 顺延；
- 动态数据目录**永远在 exe 旁边**的 `data\`，不进 PyInstaller 的 `_MEIPASS`（否则一升级就丢进度）；
- 前端优先找 exe 同级的 `dist\`，其次包内 `web\dist`；
- 默认知识库模式是 `builtin`：抽屉里不再出现「在 Obsidian 中打开」「注入错题印记」，
  换成「当前是『内置静态解析』：笔记正文与图谱随题库打包」+ 一个「连接我的 Obsidian 库」按钮（点了跳到设置的知识库分组）。

---

## 一、双击启动（源码版）

```
启动刷题系统.cmd
```

它会自动找 Python（PATH → 常见安装位置 → DSH 运行时），缺 `fastapi / uvicorn` 就自动装，
然后启动服务并打开浏览器：**http://127.0.0.1:8788/**

> 为什么 `.cmd` 里全是英文？cmd 的代码页和 UTF-8 文件编码对不上时，
> 中文行会被拆成命令直接报错（上一版就翻过车）。中文提示交给 Python 打印。
> 启动后在黑窗口里按 `Ctrl+C` 停止服务。

手动启动（等价）：

```powershell
cd anatomy-studio
python server.py
```

端口、Obsidian 库路径、AI Key 这些**都不用改代码**：按 `Ctrl + ,`（或点右上角齿轮）打开设置中心，
在界面里填就行，会存到 `data/user_config.json`。

`config.json` 现在只剩服务端监听参数（首次启动会自动迁移旧的 vault 路径到设置里）：

```json
{ "host": "127.0.0.1", "port": 8788 }
```

---

## 二、设置中心（`Ctrl + ,`）

左侧是分类导航，右侧是分组卡片。改完点「保存」，主题/字号这类会立刻生效。

| 分组 | 你能在这儿做什么 |
|---|---|
| **AI 引擎** | 选服务商预设（DeepSeek 官方 / 硅基流动 / 阿里云百炼 / 火山方舟 / 月之暗面 Kimi / 智谱 GLM / 本地 Ollama / 自定义 OpenAI 兼容），Base URL 与模型名自动填好；**模型名称是可打字、可搜索的输入框**（不是死下拉——填 `deepseek-v4.1` 这种任意新 ID 都能用），旁边 `同步` 按钮会实时调平台的 `/models` 把账号下**当前在线的全部模型**拉下来，`测试连接` 成功后也会顺手同步一次；常用模型点图钉钉成胶囊；粘贴 API Key（小眼睛可看明文）；`⚡ 测试连接` 直接告诉你「连接成功 · 240ms」还是「Key 无效或已过期」；解析触发时机三档（仅答错时 / 每次答题 / 仅手动）；解析风格（严谨教材风 / 通俗助记风） |
| **知识库** | `📦 内置静态解析模式`（默认，不需要 Obsidian）↔ `🔮 本地 Obsidian 实时联动`（填库路径 + `验证路径`，会告诉你「识别到 250 篇笔记 / 1976 张图」）；错题印记写回开关 + 阈值 2/3/5 次 |
| **刷题偏好** | 捉虫高亮三档（答题前始终 / 仅作答后复盘 / 关闭）；答对自动下一题 + 300–3000ms 延迟滑块；急救池移出阈值（连对几次）；全局快捷键开关（关掉后 A–E 不再抢键，适合在题库搜索框里打字） |
| **外观** | 三套主题（深空暗黑 / 纯黑 OLED / 纸质浅色）、题干字号（标准 / 偏大 / 特大）、减弱动效 |
| **数据与备份** | 导出 / 导入 `user_progress.json`；导入新题库包（**你的错题次数、收藏、作答历史一个都不会丢**）；危险区：仅清空错题本 / 重置全部学习数据 / 清除本地 API Key（都带二次确认） |

> `data/user_config.json` 里有你的 API Key，**已在 `.gitignore` 里排除**。
> 首次启动时它会自动用默认值重新生成一份，填上自己的 Key 即可。

### 没配 Key 的同学会看到什么？

不会白屏、不会弹红色报错。展开解析时左轨显示一张引导卡：
「还没配置大模型」+ `前往设置`（一键跳到 AI 引擎分组）+ `就看笔记原文`（直接看右侧笔记）。
已经有缓存的题直接秒开，完全不受影响。

---

## 三、两种知识库模式

| | `📦 内置静态解析模式` | `🔮 本地 Obsidian 实时联动` |
|---|---|---|
| 需要 Obsidian 吗 | 不需要 | 需要，且要填对库路径 |
| 笔记原文 | 用 `questions.json` 里打包好的片段 | 实时从 `.md` 读，随时改随时生效 |
| 图谱 / 切片 | 用随包发布的 `data/media/`（默认打了 196 张，30 MB） | 直接读你的库 |
| `obsidian://` 跳转 | 隐藏（没有可唤起的库） | 可用 |
| 错题印记写回 | 关闭（返回 409 并说明原因） | 可开，超过阈值才写 |

**打包媒体包**（把库里被题库引用的图拷进 `data/media`，同学不用装 Obsidian 也能看图）：

```powershell
python bundle_media.py            # 只拷 questions.json 真正引用到的（196 张 / 30 MB）
python bundle_media.py --all      # 拷库里全部图片（约 1GB+，不推荐）
python bundle_media.py --dry      # 先看看会拷多少，不落盘
```

后端媒体接口按 `[当前库, data/media]` **两级回退**：连了库就读库，读不到再回退到内置包
（同学的库不完整时，内置图还能兜住）。`GET /api/media-source` 能看到当前生效的根目录。

### 发出去之前自查

```powershell
# 1) 确认没把 Key 带出去
Select-String -Path data\user_config.json -Pattern '"api_key": "sk-'

# 2) 清掉自己的作答记录（同学拿到是全新状态）
python _seed_demo.py --reset

# 3) 确认媒体包在
Get-ChildItem data\media -Recurse -File | Measure-Object -Sum Length
```

---

## 四、五个页面

| 页面 | 地址 | 内容 |
|---|---|---|
| 概览 | `#/` | 覆盖率环、考前突击队列、近 14 天热力、薄弱章节、错题玫瑰图、失分概念 Top10 |
| 练习 | `#/practice` | 筛选器 + 出题 + 判分 + 解析抽屉；题数可选 `10/20/30/50` 或**「本章节全部习题」**（值 `all`，按当前筛选一次载入整池）；深链 `#/practice/anat_2559` 单题直开 |
| 分析 | `#/analysis` | 四个 KPI、双进度环、活跃天数趋势、章节正确率/覆盖率双条、最该补的 5 个章节 |
| 题库 | `#/library` | 1917 题全文检索（题干 + 知识点），按章节/题型筛，点行进练习 |
| 错题本 | 见练习页「范围」下拉 | 选 `只看错题` / `只看未掌握` / `只看收藏` |

### 章节是按「篇 → 章」两级勾选的

题库原始分类是三层树（`第一篇 运动系统 → 第一章 骨和骨连结 → 第一节…`），而一道题只记到「章」这一层。所以练习页和题库页的章节筛选器现在长这样：

- 点开是一个分篇的清单，6 个篇按题量排序：神经系统与内分泌系统 544、内脏学 512、脉管系统 359、运动系统 338、感觉器 152、人体解剖学 12。
- 每个篇下面是它的章胶囊（`骨和骨连结 190` / `肌学 148` …），**点一下加进来，再点一下取消**，可以同时勾选任意多个章。
- 篇标题左侧那个方块是**整篇全选/取消**；勾了一部分会显示 `–`。
- 筛选按钮上会写「已选 N 个章节」，右上角「清空」一键回到全部。

实现上不能只按章名筛——「总论」在内脏学、感觉器、神经系统里各有一份，所以内部用的是 `篇/章` 组合键（`运动系统/肌学`），后端 `/api/meta` 的 `groups` 字段就是这棵树。

### 笔记里的公式会渲染成公式

抽屉的「笔记原文」里混着不少 LaTeX（题库里 120 道题的正文有 `$$...$$`，共 167 个块，其中 138 个是 `\;\Longrightarrow\;` 串起来的推导链）。现在：

- **普通公式**交给 KaTeX 排（`remark-math` + `rehype-katex`，`throwOnError:false`、`strict:false`，所以 `\text{中文}` 和全角标点都吃得下），外面套一层可横向滚动的圆角卡片，窄屏也不会撑破抽屉。
- **因果链**（箭头 ≥ 2 且是 `\text{...}` 拼的长句）直接拆成一行可换行的胶囊条：`腓骨颈骨折／受压 ⟹ 腓总神经在腓骨颈外侧受损 ⟹ 小腿前群、外侧群肌瘫痪 ⟹ 足下垂 + 马蹄内翻足 + 跨阈步态`，比塞在公式里好读得多。
- 顺手修了一个老毛病：CommonMark 会把 `\;` 当成「转义的半角分号」，于是页面上一度出现 `;⟹` 这种怪东西。数据本身没问题（`questions.json` 里的反斜杠都是完整的），是渲染前被 markdown 吃掉了一层，现在送进 KaTeX 前会还原。

### 从题库点进去能一路做下去

点题库里任意一行，不会只给你一道孤零零的题：前端会把**当前这一屏筛选出来的整列题目**（默认 60 条，翻页后再点就是翻页后的整列）带进练习页，于是你能顺着做下一题，也能随时跳走。

- 练习页题干右上角有 **「选题」按钮**（队列大于 1 题时才出现），点开是题号网格：蓝色是当前题、红色是错过、绿色是做过、灰色是没做过，鼠标停上去有章节与题干前 40 字提示，点任意号码直接跳过去。
- 答完一题后底部出现 **「下一题」**；按 `Enter` 或 `→` 也一样。

### 关掉浏览器也能接着做

整组队列、当前第几题、这一组答对几题都记在浏览器本地（`localStorage` 的 `anatomy.practice.v1`，只存题目 id 不存别的东西），所以：

- **刷新 / 关掉标签页 / 明天再开**，回到练习页自动落在原来那一组、原来那道题。
- 地址栏会跟着当前题走（`#/practice/anat_1087`），把链接复制给别人也是同一道题。
- 想从头开始：练习页点「生成一组」即可覆盖。

### 设置是自动保存的

设置面板里改任何一项（主题、字号、快捷键开关、AI 触发策略……）都会在 **800 毫秒后自动落盘**，顶栏会短暂显示「自动保存中…」。切走标签页或关掉浏览器时，未完成的改动也会立刻写出。右上角「保存」按钮仍在，只是用来「立刻存一次」。

### 键盘

| 键 | 作用 |
|---|---|
| `A`–`E` / `1`–`5` | 选选项（单选点完自动判分） |
| `Enter` | 提交 / 下一题 |
| `←` `→` | 上一题 / 下一题 |
| `空格` | 展开 / 收起解析 |
| `Esc` | 关灯箱 / 关抽屉 |
| `Ctrl + ,` | 打开 / 关闭设置中心（macOS 上是 `Cmd + ,`） |

> 快捷键可在【设置 → 刷题偏好】里整体关掉；设置面板打开时也不会抢键。

---

## 五、双轨解析（AI 靶向破题 + 笔记原文）

解析抽屉顶部是三档 Apple Segmented Control：`✨ 双轨同屏`（默认）｜`🎯 靶向破题`｜`📚 笔记原文`。
宽屏下双轨是左右双栏；窄屏自动叠成单栏。

**左轨「🎯 靶向破题精析」** 三个模块：

| 模块 | 内容 |
|---|---|
| **破题眼** | 一句话点破题干考的是什么、正确答案对应笔记哪一句 |
| **干扰项排雷** | 逐个错误选项说明「错在哪个概念的偷换上」；**你刚刚选错的那一项自动置顶并标红「你的错选」** |
| **避坑锚点** | 一条对比口诀 / 易错提醒 |

右上角 `🔄 重新深度剖析` 可强制重生成；首次生成时显示骨架屏呼吸动画，生成后本地打字机逐字显示。

**右轨「📚 笔记原文」** 完整保留原有能力：`raw_markdown_context` 原文（含双链与内联图片）、
选项矩阵、并排对比、图谱灯箱、`obsidian://` 跳转、错题 Callout 写回。

### 要不要配 API Key？

**不配也能用。** 没有 Key 时后端走 `local` 模式：只搬运你笔记里的事实，
拼出「这道题问的是 X，答案 Y。笔记里的依据是……」，不调用任何大模型、不联网。

想用真 AI 写破题眼，**在设置里填**（推荐）：`Ctrl + ,` → AI 引擎 → 选服务商 → 粘贴 Key → `⚡ 测试连接` → 保存。
存进 `data/user_config.json`，下次打开自动带上。

也可以用 `.env`（老办法，仍然支持，优先级：界面设置 > 环境变量 > `.env`）：

```ini
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

任何 OpenAI 兼容端点都行（官方、第三方中转、本地 Ollama 的 `/v1` 都能填）。
`GET /api/analyze/status` 能看到 `configured` / `provider` / `style` 的当前值。

### 模型名不是写死的

各家平台模型更新很快，所以「模型名称」是一个**能打字、能搜索的输入框**，不是固定下拉：

- 直接输入 / 粘贴任意模型 ID（例如百炼新上的 `deepseek-v4.1`）就能用，不用等代码更新。
- 点右侧 `同步`（`POST /api/settings/fetch-models`）会带上当前 Base URL 与 Key 去请求平台的
  `/models`，把该账号**当前在线**的模型全部拉回来；Ollama 还会兼容原生 `/api/tags`。
  成功提示「已同步该平台 N 个可用模型」，列表缓存在 `data/user_config.json` 的 `llm.models` 里，
  并且只在 `models_from` 与当前 Base URL 一致时才展示（换服务商不会串台）。
- `⚡ 测试连接` 通了之后会自动顺带同步一次。
- 输入框下方是**常用胶囊**：钉住的（点图钉）→ 刚拉到的 → 该服务商内置推荐前 6 个，点一下即填入。
- 拉取失败不影响使用，返回的人话原因会直接显示（`HTTP 401（Key 无效或已过期）`、
  `该平台不支持 /models 接口`、`连不上：…`），继续手填就行。

内置预设覆盖 8 家（DeepSeek / 硅基流动 / 百炼 / 火山方舟 / Kimi / 智谱 / Ollama / 自定义），
每家的推荐模型见 `config.py` 的 `PROVIDERS`。

> **本地地址会自动绕过系统代理**：Windows 开着 Clash 之类的全局代理时，
> httpx 默认会读环境变量把 `http://localhost:11434` 也丢给 `127.0.0.1:7897`，结果拿到 502。
> `analysis.client_kwargs()` 会在目标是 localhost / 127.x / 10.x / 192.168.x / 172.16–31 时
> 设置 `trust_env=False`，Ollama 与局域网自建端点因此能直连。

### 缓存：刷一道存一道

生成的解析不写回 8.5 MB 的 `questions.json`（那样每存一题要重写整个文件，1.5–2 秒），
而是落到边车文件 `data/targeted_analysis.json`（几十 KB，约 2 ms 落盘）。
`GET /api/questions/{id}` 会把边车里的解析合并进响应，前端零改动就能读到。
**刷过的题再进都是秒开，不再消耗 Token。**

想把解析彻底焊进 `questions.json`（备份为 `questions.json.bak` 后原子替换）：

```powershell
python batch_analyze.py --all --write
```

### 批量预热某一章

```powershell
python batch_analyze.py --chapter 消化系统      # 按章节名宽松匹配
python batch_analyze.py --chapter 神经系统 --limit 50
python batch_analyze.py --all --local          # 不调 API，只用本地兜底跑全库
python batch_analyze.py --chapter 腹膜 --force  # 已有缓存也重生成
```

asyncio 并发（默认 4）、已有缓存自动跳过、`Ctrl+C` 中断后下次接着跑。
生成结果写进边车文件即时生效，不用重启服务。

> 系统解剖学题（毗邻/方位/走行）与组织胚胎学题（光镜/电镜/染色）用两套不同的 System Prompt，
> 后端按 module + chapter 关键词自动切换（`analysis.py` 的 `pick_system()`）。
> 前者强调五类解剖错误（张冠李戴 / 方位颠倒 / 层级混淆 / 同名不同物 / 走行分支错误），
> 后者强调五类组胚错误（观察尺度错位 / 染色性质颠倒 / 层次位置错位 / 发生来源错误 / 时序错误）。

---

## 六、五大功能

### 1. 审题「捉虫」高亮

题干里三类高危词自动上荧光笔：

- <span style="color:#ff453a">否定词</span>（不属于 / 错误的是 / 除外 / 不包括 …共 20 个）
- <span style="color:#ffd60a">方位词</span>（前内侧 / 外侧 / 后方 / 左肺 / 右肾 …共 38 个）
- <span style="color:#40c8e0">层级词</span>（光镜下 / 电镜下 / HE 染色 …共 13 个）

实现见 `web/src/lib/highlight.js`：长词优先排序后合成单条正则，返回段落数组由 React 渲染节点，
**不拼 HTML**（题干是外部数据，`dangerouslySetInnerHTML` 有注入风险）。

> 实测：`anat_3718` 命中「不能」「错误的是」「上方」，`anat_2552` 命中 10 处方位词。
> 层级词在本题库里 0 命中 —— 这个库只有系统解剖学，没有组织胚胎学的光镜/电镜题（见第六节）。

### 2. 选项级 AI 剖析矩阵

解析抽屉里的「选项矩阵」tab：A–E 五张子卡片，绿色是正确答案、红色是你选错的。

**内容不再截取笔记原文，改由大模型按人卫版口径逐项写**，格式是「【选项名】归属／支配／走向 → 故 X 为正确答案」：

```
A  【上斜肌】属眼球外肌，由滑车神经（Ⅳ）支配（非动眼神经），收缩时使瞳孔转向外下方。故 A 为本题正确答案。
C  【下斜肌】由动眼神经（Ⅲ）下支支配，收缩时使瞳孔转向外上方。
```

- 生成来源就是 `/api/questions/{id}/analyze` 一次调用里的 `option_matrix` 键（和破题眼、干扰项排雷同一次返回，不多花钱）。
- 旧题（题库里是本地脚本截的碎片）在**打开矩阵 tab 或点「AI 重新精析」**时会自动重写，并把结果**永久写回 `data/questions.json`**（带 `option_matrix_ai: true` 标记），下次秒开、不再调模型。
- 只在真的新生成时才落盘：缓存命中不重写 8 MB 文件（实测 `rewritten: False`）。
- 输出预算 `max_tokens` 从 1200 提到 3200，并被 `_repair_json()` 兜底 —— 模型把 JSON 写断了也能修回来。

「并排对比」tab 仍把 5 个选项摊成 3 列并排，专治「长得像」的干扰项（上泌涎核 vs 下泌涎核）。

### 3. 图谱 / 切片灯箱

289 道题挂了 469 张教材插图或课件切片（`obsidian_match.images`）。
抽屉右侧缩略图 → 点开全屏灯箱（半透明遮罩、`Esc` / 点遮罩关闭）。
笔记原文里嵌的图片也会内联渲染（`web/src/lib/md.js` 把 `![[...]]` 转成走代理的 markdown 图片）。
图片经 `/api/obsidian-media?path=` 代理，带路径越界防护（`safe_join`，越界返回 403）。

### 4. 一键唤起 Obsidian + 错题印记写回

- 「在 Obsidian 中打开」→ `obsidian://open?vault=人体结构学&file=wiki/exam/07_神经系统_思考题`
- 错满 **3 次**后按钮解锁 → 往命中的 `.md` 里写一段：

```markdown
<!-- anatomy-drill:anat_2559 -->
> [!danger] 刷题高频雷区（已累计错 5 次）
> 与面神经相关的脑神经核有
> 正确答案：A、C、E
```

写回是**幂等**的：同 qid 已有块就整块替换（次数更新），不会增殖；
用占位符定位避免把 `**参考答案**` 的粗体拆坏；`os.replace` 撞上 Obsidian 文件锁会重试 6 次，
仍失败返回 409 而不是把笔记写坏。

### 5. 薄弱点总览 + 考前突击队列

玫瑰图 = 错题按章节的南丁格尔分布；横向柱 = 高频失分概念 Top10。
突击队列的优先级公式（后端 `GET /api/cram`）：

```
Priority = 错误次数 × 2 − 连对次数 + (已收藏 ? 1.5 : 0)
ConsecutiveCorrect >= 3  →  移出急救池
```

---

## 七、目录

```
anatomy-studio/
├─ 启动刷题系统.cmd          双击启动（ASCII-only）
├─ server.py                 FastAPI 后端（API + 静态托管 + Obsidian 读写 + 靶向解析 + 设置中心）
├─ config.py                 用户配置读写 / 脱敏 / 枚举回退 / 旧配置迁移
├─ analysis.py               靶向解析引擎（两套 Prompt/缓存/本地兜底/流式）
├─ batch_analyze.py          按章节批量预生成解析
├─ build_question_bank.py    数据清洗 & Obsidian 挂载（生成 data/*.json）
├─ build_portable.py         打免安装包（npm build + 抽图 + 脱敏 + PyInstaller + 安全自检）
├─ bundle_media.py           把库里的图谱拷进 data/media（分发用）
├─ .gitignore                排除 user_config.json / .env / 进度文件
├─ config.json               只剩 host / port（旧的 vault 会自动迁移到设置里）
├─ .env.example              API Key 模板（可选，界面里填更省事）
├─ _check.py                 题库 Schema 自检
├─ _clean_callouts.py        清理笔记里的 anatomy-drill 标记
├─ _seed_demo.py             灌 / 清演示数据
├─ release\
│  ├─ AnatomyStudio_Portable\  便携版文件夹（exe + _internal + dist + data）
│  └─ AnatomyStudio_Portable.zip  46.7 MB，直接分发给使用者
├─ data\
│  ├─ questions.json         1917 道选择（7,017,125 B，含 obsidian_match.images / option_matrix）
│  ├─ questions_model.json   163 道三维模型题（无法做选择题，单独归档）
│  ├─ knowledge_index.json   661 个知识点
│  ├─ targeted_analysis.json 靶向解析缓存（边车，可删，删了重新生成）
│  ├─ media\                 内置图片包（196 张 / 30 MB，内置模式下用它）
│  ├─ user_config.json       界面里的设置（含 Key，已 gitignore）
│  ├─ bank_stats.json / build_report.txt
│  └─ user_progress.json     你的作答记录（可删，删了等于重置）
└─ web\
   ├─ index.html
   ├─ src\                    React 源码（CSS 变量驱动三套主题）
   │  ├─ components\ChapterPicker.jsx   篇→章两级多选器（createPortal 弹层）
   │  ├─ components\NoteMarkdown.jsx    笔记渲染（KaTeX 公式 + 推导链胶囊）
   │  └─ lib\md.js                       wiki 双链/图片/Latex 清洗与切块
   └─ dist\                   构建产物（server.py 托管这里）
```

### 重新生成题库

```powershell
cd anatomy-studio
python build_question_bank.py     # 约 2–3 分钟
python bundle_media.py            # 题库换了就把新引用的图重新打包
cd web; npm run build             # 约 30 秒
```

### 改前端

```powershell
cd web
npm run dev      # vite :5173，/api 已代理到 :8788
```

---

## 八、数据来源与口径

- 题面、选项、答案来自「解剖助手」客户端调用的校内接口 `/zapi/chapter/getxitilist`
  与 `/zapi/xiti/tijiaoanswer`（该接口不返回答案，答案只能提交后由服务端回传；
  1917 道全部收割完毕，三维模型题 163 道无法提交文字答案，单独放 `questions_model.json`）。
- 证据来自 Obsidian 库 你自己的 Obsidian 库：教材转换稿（7 章）、考点库（117 道章末思考题）、
  概念页（230 篇）。检索用 BM25 二元组，不依赖术语词典（词典只有 928 词，
  查不到「附睾被膜」「扣带回」「破裂孔」这类低频专名）。
- 质量：有正文 1917/1917，选项级定义 7669/9585（80.0%），有图谱 289 道 469 张，
  否定式题干标注 158 道，无匹配 0 道，Schema 校验 0 错。
  另有 12 道「选项全是方位词/形状词」的题走专用通道（主题词锚定 + 过滤），
  不再被「向内侧/向上」这类高频词带偏到无关章节。

---

## 九、几条实话

1. **这个库只有系统解剖学**。`module` 字段 1917 题全是「系统解剖学」——
   源客户端就没有组织胚胎学题，所以捉虫的「光镜下/电镜下」类词在这套题里命中 0 次，
   功能保持可用，等你换到组胚题源时才会亮。
2. **163 道三维模型题做不了选择题**：它们的选项是模型上的热点，接口返回 `xuanxiang = "[]"`。
   已单独归档，不混进练习池。
3. **题库内置的选项定义只有 80.0% 有内容，但界面已经不靠它了**。旧的「选项矩阵」是从笔记里截片段，
   连纯方位/形状选项（如「子宫腔呈：椭圆形/三角形」）都截不准，还爱写「笔记未提及」。
   现在改成**大模型按人卫版口径逐项写**（见第五节·2），截不出片段的选项也会有一句正经医学定义；
   配了 Key 之后打开矩阵 tab 就会自动把旧文本重写掉并存回题库。纯方位题我们仍然刻意**不给**内置定义
   （给了就是错的），但那只是「题库内置值」——AI 版会正常解释「这是方位描述而不是结构名」。
4. 首次启动如果自动装 `fastapi / uvicorn` 失败，手动跑：
   `python -m pip install fastapi uvicorn`。
   上传题库包的功能还需要 `python -m pip install python-multipart`。
5. 演示数据：本轮验收用的演示作答记录可以直接清掉 —— `python _seed_demo.py --reset`
   （或者在【设置 → 数据与备份】里点「重置全部学习数据」）；想看大屏效果再 `python _seed_demo.py --n 96` 灌回去。
6. **不配 Key 时左轨是「本地推导」不是 AI**。它只做笔记事实的摘录与拼接，不会替你编造笔记里没有的内容，
   所以某些选项会出现「笔记未收录该名词」——那是在如实告诉你这个知识点在 Obsidian 里还没有页，
   有空可以补一条概念页。右下角来源标签会明确写「本地推导 · 未调用大模型」。
7. **发布前记得清 Key**：`data/user_config.json` 里存着你的 API Key（`.gitignore` 已排除），
   直接打包整个文件夹时它会一起被带走。正确做法是用 `python build_portable.py` 生成
   `release\AnatomyStudio_Portable\`——那份配置是脚本生成的脱敏版本（`api_key=""`），
   而且构建最后一步会全文扫描发布目录、确认连一个 `sk-` 都没有。
8. **便携版不是「绿色单文件」**：`_internal\` 里的 dll 是这个 exe 的运行时，
   文件夹必须整体拷贝，只发 `AnatomyStudio.exe` 会启动失败。
   另外它自带控制台窗口（故意的）——关掉窗口服务就停，这是让同学「看得见进程」的最省事方式。
9. **选项证据条现在只显示真正对得上的片段**。原来 7642 条内置片段里有 54.4% 挂错了对象
   （「肺韧带」拿到了 Treitz 韧带的描述，纯靠后缀「韧带」命中），现在按「选项名或其前三个字
   必须出现在片段里」重新过了一遍：清掉 2940 条明显不相干的，其余 4697 条顺带抹掉了
   markdown 与双链残留。剩下的空位打开矩阵 tab 让 AI 补一句正经定义即可。
