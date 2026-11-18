---
name: wechat2md
description: 微信公众号文章转 Markdown。支持本地 HTML 文件、mp.weixin.qq.com 链接抓取、贴图文章（分享页 cgiDataNew）、以及修复已转换 markdown 中残留的原始 HTML 表格块（表格换行渲染失效、代码块被截断等问题）。当用户需要把微信文章或公众号链接转成 Markdown、修复微信文章转换产物、或批量归档公众号内容时使用。
---

# 微信公众号文章 → Markdown

用打包好的脚本，不要手写转换逻辑——微信 HTML 的坑都已处理并逐字节验证过（85 篇文章、151 个表格全部干净转换）。

## 快速开始

```bash
npm i jsdom turndown turndown-plugin-gfm   # 在工作目录装一次
node <skill-dir>/scripts/wechat2md.mjs article.html        # 整页/片段 → .md
node <skill-dir>/scripts/wechat2md.mjs broken.md           # 修复内嵌 <table> HTML 块（原地写回，--dry 只报告）
node <skill-dir>/scripts/wechat2md.mjs https://mp.weixin.qq.com/s/xxx   # 抓取 → .md
```

支持多输入循环、`-o out.md` 指定输出。脚本从**运行目录**解析依赖（createRequire），所以先在目标目录 npm i。

## 微信的三个坑（为什么必须用脚本）

**1. 正文在 `#js_content` 里，且带 `visibility: hidden` 内联样式。**
通用 Readability 工具会跳过或返回空。必须直接取 `#js_content`，并复刻 Readability 的 `_cleanStyles()` 递归删除表现属性（align/style/bgcolor 等 12 个，SVG 豁免，class 保留）。

**2. 表格单元格全部被包进 `<section><span leaf="">`。**
`section` 是块级元素，任何"复杂表格保留 HTML"的规则都会命中 → 整个表格以原始 HTML 输出，渲染不出换行和表格线。修复：转换前解包 `table section, table span`（空壳如 `<br>` 占位直接删，`code`/`img`/`a` 保留），简单表格即可走 GFM 转 markdown。这是最常见的问题，症状就是"表格是 HTML、换行失效"。

**3. 新版代码块是 `<pre>` 内每行一个 `<code>` 子元素，行间无换行符，缩进用 `&nbsp;`。**
turndown 默认和 gfm 插件都只读 `firstChild.textContent` → 多行代码被截成第一行。需要自定义规则逐行拼接并把 `\u00A0` 转回空格。代码内含 ``` 时围栏自动加长。

## 贴图文章（分享页 / `item_show_type=8`）

有一类文章微信只返回「分享页」模板（`common_share.html`）：页面里**没有 `#js_content`**，正文和图片全在 `window.cgiDataNew` 这个 JS 字面量里。以前找不到 `#js_content` 就整页转，把 2MB 内联 JS 当正文输出（粘进笔记软件会卡死）。

脚本现在会解析这个字面量，取出：

| 字段 | 用途 |
| --- | --- |
| `title` / `nick_name` / `author` / `create_time` | frontmatter |
| `content_noencode` | 正文纯文本（按 `\n` 分段） |
| `picture_page_info_list[].cdn_url` | 正文配图（跳过 `is_qr_code=1`） |

输出 frontmatter 会带 `kind: pictext` 以区分。解析器是**手写的 JS 字面量解析器，不 eval 页面代码**：支持单引号字符串与 `\xNN`/`\uNNNN` 转义、无引号 key、尾逗号、以及微信数据里常见的 `'0' * 1` 类型强转。

判定顺序：有 `#js_content` → 正常文章；没有但能解析出 `cgiDataNew` 且有正文或配图 → 贴图文章；两者都没有 → `FAIL NO_CONTENT(疑似风控/已删/分享页无数据)`，不产出空文件。

## 什么时候表格应该保留 HTML

colspan/rowspan、多行 thead、caption/tfoot、单元格内含真实块级内容——GFM 表达不了，保留原始 HTML 是**正确行为**，不要强行转。脚本会自动判断并打印 `kept as HTML`。

## 抓取礼仪（URL 模式）

- iPhone Safari UA（脚本已内置）
- 批量抓取间隔 10~20s 随机；单篇无所谓
- `#js_content` 为空或极短 = 疑似风控/已删，退避 60s 再试；断点续传按"文件已存在则跳过"实现
- 元数据从页面内嵌 JS 变量提取：`msg_title`/`author`/`nickname`/`ct`（Unix 秒，转 Asia/Shanghai），写入 YAML frontmatter

## Turndown 配置（自己写管线时对齐）

`headingStyle: atx, codeBlockStyle: fenced, bulletListMarker: -, emDelimiter: _, strongDelimiter: **, linkStyle: inlined, hr: ---` + `turndown-plugin-gfm`。规则注册顺序：gfm 插件 → complexTableAsHtml → wechatCodeBlock（后注册先命中）。
