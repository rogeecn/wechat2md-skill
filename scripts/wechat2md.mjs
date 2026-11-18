#!/usr/bin/env node
// 微信公众号文章 → Markdown
// 用法:
//   node wechat2md.mjs article.html [-o out.md]   整页/片段 → markdown
//   node wechat2md.mjs broken.md [-o fixed.md]    修复内嵌 <table> HTML 块（默认原地写回，--dry 只报告）
//   node wechat2md.mjs <mp.weixin.qq.com URL>     抓取 → markdown（iPhone UA）
//   多输入循环处理。依赖（在运行目录安装）: npm i jsdom turndown turndown-plugin-gfm
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";

const req = createRequire(process.cwd() + "/");
let JSDOM, TurndownService, gfm;
try {
  ({ JSDOM } = req("jsdom"));
  TurndownService = req("turndown");
  ({ gfm } = req("turndown-plugin-gfm"));
} catch {
  console.error(
    "缺少依赖。先在当前目录执行: npm i jsdom turndown turndown-plugin-gfm",
  );
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// ---------- Turndown 配置（复刻 Linkly AI Clipper 的 getTurndownService，逐字节对齐验证过） ----------
function makeTd() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
    hr: "---",
  });
  td.use(gfm);
  // 复杂表格保留 HTML：colspan/rowspan、多行 thead、caption/tfoot、或单元格内含真实块级元素。
  // GFM 表格表达不了这些，整块保留是正确行为。
  td.addRule("complexTableAsHtml", {
    filter: (node) =>
      node.nodeName === "TABLE" &&
      (node.querySelector("caption, tfoot") ||
        (node.querySelector("thead") &&
          node.querySelectorAll("thead tr").length > 1) ||
        [...node.querySelectorAll("th, td")].some(
          (c) =>
            Number(c.getAttribute("colspan") || 1) !== 1 ||
            Number(c.getAttribute("rowspan") || 1) !== 1 ||
            c.querySelector(
              "address,article,aside,blockquote,br,canvas,details,div,dl,fieldset,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,nav,ol,p,pre,section,table,ul,video",
            ),
        )),
    replacement: (_c, node) =>
      `\n\n${node.outerHTML.replace(/\n\s*\n+/g, "\n")}\n\n`,
  });
  // 微信新版代码块：<pre> 内每行一个 <code> 子元素（行间无换行符）。
  // turndown 默认 fencedCodeBlock 和 gfm 插件都只读 firstChild.textContent，多行块会被截成第一行。
  // 此规则注册在后、先命中，逐行拼接。&nbsp; 是微信的缩进手段，转回普通空格。
  // 注意：turndown 在 Node 端用 domino 解析（非 jsdom），HTMLCollection 无 Symbol.iterator，不能 spread。
  td.addRule("wechatCodeBlock", {
    filter: (node) =>
      node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
    replacement: (_c, node, options) => {
      const lines = [];
      for (let c = node.firstElementChild; c; c = c.nextElementSibling)
        if (c.nodeName === "CODE")
          lines.push(c.textContent.replace(/\u00A0/g, " "));
      const code = lines.join("\n").replace(/\n+$/, "");
      const lang =
        node.getAttribute("data-lang") ||
        node.firstChild.getAttribute("class")?.match(/language-(\S+)/)?.[1] ||
        "";
      let fence = options.fence;
      for (const m of code.matchAll(/^`{3,}/gm))
        if (m[0].length >= fence.length) fence = "`".repeat(m[0].length + 1); // 代码内含 ``` 时加长围栏
      return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
    },
  });
  return td;
}

// ---------- 清洗：Readability _cleanStyles 复刻（递归删表现属性，SVG 豁免，class 保留） ----------
const PRESENTATIONAL = [
  "align",
  "background",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "frame",
  "hspace",
  "rules",
  "style",
  "valign",
  "vspace",
];
function cleanStyles(e) {
  if (e.tagName?.toLowerCase() === "svg") return;
  for (const a of PRESENTATIONAL) e.removeAttribute?.(a);
  for (let c = e.firstElementChild; c; c = c.nextElementSibling) cleanStyles(c);
}

// ---------- 关键修复：微信表格解包 ----------
// 微信把每个单元格内容包进 <section><span leaf="">，section 是块级元素 → 所有表格都被
// complexTableAsHtml 判成"复杂表格"整块保留原始 HTML（渲染不出换行/表格）。
// 解包 table 内 section/span（空壳如 <br> 占位直接删），保留 code/img/a 等内联元素，
// 简单表格即可走 GFM 转成 markdown 表格。
function simplifyTables(root) {
  for (const el of [...root.querySelectorAll("table section, table span")]) {
    if (!el.textContent.trim() && !el.querySelector("code,img,a")) {
      el.remove();
      continue;
    }
    el.replaceWith(...el.childNodes);
  }
}

// ---------- 元数据 ----------
const yq = (s) =>
  `"${String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
const fmtPub = (ts) =>
  new Date(ts * 1000)
    .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    .replace(/^(\d+)\/(\d+)\/(\d+) (\d+:\d+):\d+$/, "$1年$2月$3日 $4");
function meta(html, doc, fallbackTitle) {
  const title =
    (html.match(/var msg_title = '([^']*)'/) || [])[1] ||
    (doc.querySelector("#activity-name")?.textContent || "").trim() ||
    fallbackTitle ||
    "";
  const author =
    (html.match(/var author = htmlDecode\("([^"]*)"\)/) || [])[1] ||
    (html.match(/var author = "?([^";]*)/) || [])[1] ||
    "";
  const site =
    (html.match(/var nickname = htmlDecode\("([^"]*)"\)/) || [])[1] ||
    (html.match(/var nickname = "?([^";]*)/) || [])[1] ||
    "";
  const ct = Number((html.match(/var ct = "?(\d+)/) || [])[1] || 0);
  return { title, author, site, ct };
}

// ---------- HTML → Markdown ----------
function convertHtml(html, fallbackTitle = "") {
  const doc = new JSDOM(html).window.document;
  const content = doc.querySelector("#js_content") || doc.body;
  cleanStyles(content);
  simplifyTables(content);
  const m = meta(html, doc, fallbackTitle);
  const td = makeTd();
  const md = td
    .turndown(content.innerHTML)
    .replace(/\u00A0/g, " ")
    .replace(/\n+$/, "\n");
  const fm = [`---`, `type: WeChat Article`];
  if (m.title) fm.push(`title: ${yq(m.title)}`);
  if (m.site) fm.push(`site: ${yq(m.site)}`);
  if (m.author) fm.push(`author: ${yq(m.author)}`);
  if (m.ct) fm.push(`published: ${yq(fmtPub(m.ct))}`);
  if (String(process.argv).includes("http")) fm.push(`source: ${yq(fallbackTitle)}`);
  fm.push(`---`, ``);
  return `${fm.join("\n")}\n\n${m.title ? `# ${m.title}\n\n` : ""}${md}`;
}

// ---------- 修复已损坏的 markdown（内嵌 <table> HTML 块） ----------
function repairMd(src) {
  let conv = 0,
    kept = 0;
  const out = src.replace(/<table[\s\S]*?<\/table>/g, (blob) => {
    const doc = new JSDOM(blob).window.document;
    // 与采集管线 simplifyTables 相同：解包 section/span（空壳删除），保留 code
    for (const el of [...doc.querySelectorAll("section, span")]) {
      if (!el.textContent.trim() && !el.querySelector("code,img,a")) {
        el.remove();
        continue;
      }
      el.replaceWith(...el.childNodes);
    }
    const md = makeTd()
      .turndown(doc.body.innerHTML)
      .replace(/\u00A0/g, " ")
      .trim();
    if (!md.startsWith("|")) {
      kept++;
      return blob; // 仍复杂（colspan 等）→ 保留原 HTML
    }
    conv++;
    return md;
  });
  return { out, conv, kept };
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const oi = args.indexOf("-o");
const OUT = oi >= 0 ? args.splice(oi, 2)[1] : null;
const inputs = args.filter(Boolean);

if (!inputs.length) {
  console.error(
    "用法: node wechat2md.mjs <file.html | file.md | URL> [...] [-o out] [--dry]",
  );
  process.exit(1);
}

for (const input of inputs) {
  if (/^https?:\/\//.test(input)) {
    // URL 抓取
    const res = await fetch(input, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`FAIL HTTP ${res.status} ${input}`);
      continue;
    }
    const html = await res.text();
    const doc = new JSDOM(html).window.document;
    const content = doc.querySelector("#js_content");
    if (!content || content.textContent.trim().length < 100) {
      console.error(`FAIL NO_CONTENT(疑似风控/已删) ${input}`);
      continue;
    }
    const name = (meta(html, doc).title || "article")
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]+/g, " ")
      .trim()
      .slice(0, 50) || "article";
    const md = convertHtml(html, input);
    const path = OUT || `${name}.md`;
    writeFileSync(path, md);
    console.log(`OK ${md.length}c -> ${path}`);
    continue;
  }

  const src = readFileSync(input, "utf8");
  if (input.endsWith(".md")) {
    // 修复模式
    const { out, conv, kept } = repairMd(src);
    if (out === src) {
      console.log(`${input}: no <table> blobs found`);
      continue;
    }
    if (!DRY) writeFileSync(OUT || input, out);
    console.log(
      `${input} -> ${conv} converted${kept ? `, ${kept} kept as HTML (colspan等复杂表格)` : ""}${DRY ? " (DRY)" : ""}`,
    );
  } else {
    // HTML 转换模式
    const md = convertHtml(src);
    const path = OUT || input.replace(/\.html?$/i, ".md");
    writeFileSync(path, md);
    console.log(`OK ${md.length}c -> ${path}`);
  }
}
