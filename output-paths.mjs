const SUBREDDIT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POST_ID_PATTERN = /^[a-z0-9]+$/i;
const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com"]);

export class OutputPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OutputPathError";
    this.code = code;
  }
}

export function normalisePostId(value) {
  const raw = String(value || "").trim().replace(/^t3_/i, "").toLowerCase();
  if (!POST_ID_PATTERN.test(raw)) {
    throw new OutputPathError("POST_ID_UNAVAILABLE", "帖子代码无效，未写入任何文件。");
  }
  return raw;
}

export function normaliseUrlSlug(value) {
  let decoded = String(value || "").trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch { /* Keep the raw path segment when it is malformed. */ }
  let slug = decoded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  if (!slug && decoded) {
    slug = [...decoded]
      .map((character) => `u${character.codePointAt(0).toString(16)}`)
      .join("_")
      .slice(0, 96);
  }
  if (!slug) {
    throw new OutputPathError("POST_URL_SLUG_UNAVAILABLE", "帖子永久链接缺少可用标题，未写入任何文件。");
  }
  return slug;
}

export function postPermalinkDetails(value, expectedPostId) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new OutputPathError("POST_PERMALINK_INVALID", "帖子永久链接无效，未写入任何文件。");
  }
  if (url.protocol !== "https:" || !REDDIT_HOSTS.has(url.hostname)) {
    throw new OutputPathError("POST_PERMALINK_INVALID", "帖子永久链接不是 Reddit HTTPS 链接，未写入任何文件。");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
  const urlPostId = commentsIndex >= 0 ? normalisePostId(segments[commentsIndex + 1]) : null;
  const postId = normalisePostId(expectedPostId);
  if (!urlPostId || urlPostId !== postId) {
    throw new OutputPathError("POST_PERMALINK_MISMATCH", "帖子永久链接与帖子代码不匹配，未写入任何文件。");
  }
  const rawSlug = segments[commentsIndex + 2] || "";
  if (!rawSlug || rawSlug.toLowerCase() === "comment") {
    throw new OutputPathError("POST_URL_SLUG_UNAVAILABLE", "帖子永久链接缺少帖子标题段，未写入任何文件。");
  }
  return {
    postId,
    urlSlug: normaliseUrlSlug(rawSlug),
    canonicalUrl: `${url.origin}/${segments.slice(0, commentsIndex + 3).join("/")}/`
  };
}

export function postDirectory(entry, post, { layer = "raw-v2" } = {}) {
  const subredditSlug = String(entry?.slug || "").trim();
  if (!SUBREDDIT_SLUG_PATTERN.test(subredditSlug)) {
    throw new OutputPathError("SUBREDDIT_SLUG_UNAVAILABLE", "subreddit 目录名无效，未写入任何文件。");
  }
  const postId = normalisePostId(post?.post_id || post?.id || post?.fullname || post?.post_fullname);
  const permalink = post?.canonical_url || post?.source_url || post?.source_url_or_raw_path;
  const details = postPermalinkDetails(permalink, postId);
  const outputLayer = String(layer || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(outputLayer)) {
    throw new OutputPathError("OUTPUT_LAYER_UNAVAILABLE", "输出层目录名无效，未写入任何文件。");
  }
  const directoryName = `${details.postId}--${details.urlSlug}`;
  return {
    slug: subredditSlug,
    postId: details.postId,
    urlSlug: details.urlSlug,
    directoryName,
    canonicalUrl: details.canonicalUrl,
    relativeDirectory: `${outputLayer}/${subredditSlug}/${directoryName}`
  };
}

export function resolvePostDirectoryName(existingNames, postId, preferredDirectoryName) {
  const expectedPostId = normalisePostId(postId);
  const prefix = `${expectedPostId}--`;
  const matches = [...(existingNames || [])].filter((name) => String(name || "").toLowerCase().startsWith(prefix));
  if (matches.length > 1) {
    throw new OutputPathError("POST_DIRECTORY_CONFLICT", `帖子 ${expectedPostId} 对应多个目录，未写入任何文件。`);
  }
  return matches[0] || preferredDirectoryName;
}
