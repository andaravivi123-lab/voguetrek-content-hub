import { copyFileSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'content/posts');
const dist = join(root, 'dist');
const markdown = new MarkdownIt({ html: false });
const escape = markdown.utils.escapeHtml;
const brand = '艾优享趣 voguetrek';

function page(title, content, prefix) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <style>
    body { margin: 0; background: #f7f4ef; color: #1e241f; font-family: Manrope, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.85; }
    header, main { max-width: 44rem; margin: auto; padding: 1.5rem; }
    header { border-bottom: 1px solid #a49e94; }
    header img { display: block; width: 10rem; height: auto; }
    h1, h2, h3 { font-family: Montserrat, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.3; }
    a { color: #0e4f43; }
    img { max-width: 100%; height: auto; }
    pre { overflow: auto; }
  </style>
</head>
<body>
  <header><a href="${prefix}index.html"><img src="${prefix}logo.webp" alt="${brand}"></a></header>
  <main>${content}</main>
</body>
</html>
`;
}

const posts = new Map();
for (const path of globSync('**/*.md', { cwd: sourceDir }).sort()) {
  const source = readFileSync(join(sourceDir, path), 'utf8').replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(source)) {
    throw new Error(`${path}: expected YAML frontmatter.`);
  }
  const { data, content } = matter(source, { language: 'yaml' });
  const defaultSlug = path.slice(0, -3).replace(/[^\p{L}\p{N}_-]+/gu, '-');
  const { title, slug = defaultSlug } = data ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error(`${path}: expected a non-empty title.`);
  }
  if (typeof slug !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(slug)) {
    throw new Error(`${path}: set a slug containing letters, numbers, dashes or underscores.`);
  }
  if (posts.has(slug)) throw new Error(`${path}: duplicate slug "${slug}".`);
  posts.set(slug, { title, content: markdown.render(content) });
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'posts'), { recursive: true });
copyFileSync(join(root, 'site/logo.webp'), join(dist, 'logo.webp'));
const links = [];
for (const [slug, { title, content }] of posts) {
  writeFileSync(join(dist, 'posts', `${slug}.html`),
    page(`${title} | ${brand}`, `<article><h1>${escape(title)}</h1>${content}</article>`, '../'));
  links.push(`<li><a href="posts/${encodeURIComponent(slug)}.html">${escape(title)}</a></li>`);
}
writeFileSync(join(dist, 'index.html'), page(brand, `<h1>${brand}</h1><ul>${links.join('')}</ul>`, './'));
console.log(`Built ${posts.size} article(s) in dist/.`);
