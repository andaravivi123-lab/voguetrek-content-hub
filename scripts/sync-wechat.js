import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';

const root = fileURLToPath(new URL('..', import.meta.url));
const markdown = new MarkdownIt({ html: false });
const api = 'https://api.weixin.qq.com/cgi-bin';
const env = process.env;

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveCommit(ref) {
  return git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
}

function changedPosts() {
  const head = resolveCommit(env.GIT_HEAD_SHA || 'HEAD');
  const parents = git('show', '-s', '--format=%P', head).trim().split(' ');
  const baseRef = env.GIT_BASE_SHA;
  let base = parents[0];
  if (baseRef && !/^0+$/.test(baseRef)) {
    base = resolveCommit(baseRef);
  } else if (baseRef || !base) {
    base = git('hash-object', '-t', 'tree', '--stdin').trim();
  }

  const paths = git(
    'diff', '--name-only', '-z', '--diff-filter=AM', '--no-renames',
    base, head, '--', 'content/posts/',
  ).split('\0').filter((path) => /\.md$/i.test(path));

  return { head, paths };
}

function readArticle(head, path) {
  const source = git('show', `${head}:${path}`).replace(/^\uFEFF/, '');
  // Require a plain YAML delimiter so gray-matter cannot select a JS engine.
  const opening = source.match(/^---[ \t]*\r?\n/);
  if (!opening || !/^---[ \t]*(?:\r?\n|$)/m.test(source.slice(opening[0].length))) {
    throw new Error(`${path}: expected YAML frontmatter delimited by ---.`);
  }

  let article;
  try {
    article = matter(source, { language: 'yaml' });
  } catch {
    throw new Error(`${path}: invalid YAML frontmatter.`);
  }

  const { title, thumb_media_id } = article.data ?? {};
  if (typeof title !== 'string' || !title.trim() || !article.content.trim()) {
    throw new Error(`${path}: a non-empty title and Markdown body are required.`);
  }

  return {
    title: title.trim(),
    content: markdown.render(article.content),
    thumb_media_id: thumb_media_id ?? env.WECHAT_THUMB_MEDIA_ID,
  };
}

async function request(endpoint, url, options) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`WeChat ${endpoint}: ${error.name === 'TimeoutError' ? 'request timed out' : 'network request failed'}.`);
  }

  if (!response.ok) {
    throw new Error(`WeChat ${endpoint}: HTTP ${response.status}.`);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`WeChat ${endpoint}: invalid JSON response.`);
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`WeChat ${endpoint}: unexpected response.`);
  }
  if (result.errcode && result.errcode !== '0') {
    throw new Error(`WeChat ${endpoint}: API error (errcode=${Number(result.errcode)}).`);
  }
  return result;
}

async function getToken() {
  const configured = env.WECHAT_ACCESS_TOKEN?.trim();
  if (configured) return configured;
  if (!env.WECHAT_APP_ID?.trim() || !env.WECHAT_APP_SECRET?.trim()) {
    throw new Error('Set WECHAT_ACCESS_TOKEN or both WECHAT_APP_ID and WECHAT_APP_SECRET.');
  }
  const url = new URL(`${api}/token`);
  url.search = new URLSearchParams({
    grant_type: 'client_credential',
    appid: env.WECHAT_APP_ID.trim(),
    secret: env.WECHAT_APP_SECRET.trim(),
  });
  const { access_token } = await request('token', url);
  if (!access_token) throw new Error('WeChat token: missing access_token.');
  return access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === '--dry-run';
  if (args.length && !dryRun) throw new Error('Usage: node scripts/sync-wechat.js [--dry-run]');

  const { head, paths } = changedPosts();
  if (!paths.length) {
    console.log('No added or modified Markdown posts.');
    return;
  }

  const articles = paths.map((path) => {
    const article = readArticle(head, path);
    if (!dryRun && (typeof article.thumb_media_id !== 'string' || !article.thumb_media_id.trim())) {
      throw new Error(`${path}: set thumb_media_id in frontmatter or WECHAT_THUMB_MEDIA_ID.`);
    }
    if (typeof article.thumb_media_id === 'string') {
      article.thumb_media_id = article.thumb_media_id.trim();
    }
    return article;
  });

  if (dryRun) {
    paths.forEach((path, index) => console.log(`Would upload ${JSON.stringify(path)}: ${articles[index].title}`));
    return;
  }

  const url = new URL(`${api}/draft/add`);
  url.searchParams.set('access_token', await getToken());
  for (const [index, article] of articles.entries()) {
    const path = JSON.stringify(paths[index]);
    try {
      const result = await request('draft/add', url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ articles: [article] }),
      });
      if (!result.media_id) throw new Error('WeChat draft/add: missing media_id.');
      console.log(`Created draft for ${path}: ${result.media_id}`);
    } catch (error) {
      throw new Error(`${path}: ${error.message} ${index} earlier draft(s) confirmed.`);
    }
  }
}

main().catch((error) => {
  console.error(error.stderr?.trim() || error.message);
  process.exitCode = 1;
});
