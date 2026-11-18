# wechat2md-skill

微信公众号文章 → Markdown 的 Agent Skill。纯本地脚本，**不需要部署服务、不经过任何中转/代理服务器**，直接读本地 HTML 或用 iPhone UA 抓 `mp.weixin.qq.com` 页面。

- `SKILL.md` — 给 Agent 用的技能说明（触发条件、命令、微信的三个坑）
- `scripts/wechat2md.mjs` — 转换器本体（ESM，~260 行）

## 用法

```bash
npm i jsdom turndown turndown-plugin-gfm   # 在运行目录装一次

# 整页或正文片段 HTML → markdown
node scripts/wechat2md.mjs article.html

# 抓取线上文章 → markdown
node scripts/wechat2md.mjs https://mp.weixin.qq.com/s/xxxx

# 修复已被转换坏掉的 markdown（内嵌原始 <table> HTML 块）
node scripts/wechat2md.mjs broken.md --dry     # 只报告
node scripts/wechat2md.mjs broken.md           # 原地写回

# 多输入循环、指定输出
node scripts/wechat2md.mjs a.html b.html -o out.md
```

输出带 YAML frontmatter（`title` / `site` / `author` / `published` / `source`），正文首行是 `# 标题`。

**贴图文章**（微信只给分享页、页面里没有 `#js_content` 的那一类）已支持：正文与配图从 `window.cgiDataNew`（`content_noencode` + `picture_page_info_list[].cdn_url`）里取，frontmatter 会标 `kind: pictext`。解析器手写、不 eval 页面代码。

## 为什么必须用脚本

微信的 HTML 有三个坑，通用 Readability / turndown 默认配置全部会踩：

1. **正文在 `#js_content` 里**，且带 `visibility: hidden` 内联样式 —— 通用正文提取器会跳过或返回空。脚本直接取 `#js_content`，并复刻 Readability 的 `_cleanStyles()` 递归删除 12 个表现属性（SVG 豁免，`class` 保留）。
2. **表格单元格被 `<section><span leaf="">` 包裹** —— `section` 是块级元素，任何「复杂表格保留 HTML」的规则都会命中，整张表以原始 HTML 输出，渲染不出换行和表格线。脚本在转换前解包 `table section, table span`（空壳删除，`code`/`img`/`a` 保留），简单表格即可正常转成 GFM 表格。
3. **新版代码块是 `<pre>` 内每行一个 `<code>`，行间没有换行符，缩进用 `&nbsp;`** —— turndown 默认规则和 gfm 插件都只读 `firstChild.textContent`，多行代码被截成第一行。脚本自定义规则逐行拼接，把 `\u00A0` 转回空格，代码内出现 ``` 时自动加长围栏。

4. **贴图文章没有 `#js_content`** —— 微信只返回分享页模板，正文/图片全在 `window.cgiDataNew` 里。整页转会把内联 JS 当正文（2MB 起步），脚本改为解析该字面量。

已用 85 篇文章、151 个表格逐字节验证；复杂表格（colspan/rowspan、多行 thead、caption/tfoot、单元格含真实块级内容）会**故意保留为 HTML**，GFM 表达不了，脚本会打印 `kept as HTML`。

## 抓取礼仪

iPhone Safari UA（内置）；批量抓取间隔 10~20s 随机；`#js_content` 为空或极短视为风控/已删，退避 60s 重试；断点续传用「文件已存在则跳过」。

## 依赖说明

脚本从**运行目录**解析依赖（`createRequire(cwd)`），所以 `npm i` 装在哪儿、脚本就放哪儿都能跑。`jsdom` 只在 `turndown` 需要的 DOM 上做页面解析；`turndown` 内部用 domino。

## License

MIT