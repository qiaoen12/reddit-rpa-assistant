const CANONICAL_SUBREDDIT_PATTERN = /^[a-z0-9][a-z0-9_]{1,20}$/;
const CANONICAL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUBREDDIT_STATUSES = new Set(["active", "archived"]);

export class SubredditRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubredditRegistryError";
    this.code = code;
  }
}

function requiredValue(value, code, message) {
  if (!value) throw new SubredditRegistryError(code, message);
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记 JSON 格式无效，未写入任何文件。");
  }
}

export function normaliseSubredditName(value) {
  let raw = String(value || "").normalize("NFKC").trim();
  raw = raw.replace(/^https?:\/\/(?:www\.)?reddit\.com/i, "");
  raw = raw.replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, "").trim();
  if (/[^A-Za-z0-9_]/.test(raw)) return null;
  if (!CANONICAL_SUBREDDIT_PATTERN.test(raw.toLowerCase())) return null;
  return raw;
}

export function canonicalSubredditName(value) {
  const normalised = normaliseSubredditName(value);
  return normalised ? normalised.toLowerCase() : null;
}

export function isCanonicalSlug(value) {
  return CANONICAL_SLUG_PATTERN.test(String(value || ""));
}

export function canonicalSlugForSubreddit(value) {
  const canonical = canonicalSubredditName(value);
  if (!canonical) return null;
  const slug = canonical.replace(/_/g, "-");
  return isCanonicalSlug(slug) ? slug : null;
}

function collectionFromRegistry(registry) {
  const collection = registry?.collection;
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
    throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少采集集合信息，未写入任何文件。");
  }
  const collectionId = requiredValue(String(collection.collectionId || "").trim(), "SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少 collectionId，未写入任何文件。");
  const name = requiredValue(String(collection.name || "").trim(), "SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少集合名称，未写入任何文件。");
  if (collection.kind !== "collection") {
    throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表的集合类型无效，未写入任何文件。");
  }
  return { collectionId, name };
}

function registryEntries(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少对象结构，未写入任何文件。");
  }
  const collection = collectionFromRegistry(registry);
  if (!Array.isArray(registry.subreddits)) {
    throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表缺少 subreddit 列表，未写入任何文件。");
  }

  const names = new Set();
  const slugs = new Set();
  return registry.subreddits.map((subreddit) => {
    if (!subreddit || typeof subreddit !== "object" || Array.isArray(subreddit)) {
      throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表包含无效项目，未写入任何文件。");
    }
    const displayName = requiredValue(normaliseSubredditName(subreddit.subreddit), "SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 显示名无效，未写入任何文件。");
    const canonicalName = requiredValue(canonicalSubredditName(subreddit.canonicalName || displayName), "SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit canonicalName 无效，未写入任何文件。");
    const slug = String(subreddit.slug || "").trim();
    const category = requiredValue(String(subreddit.category || "").trim(), "SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 分类无效，未写入任何文件。");
    if (!isCanonicalSlug(slug) || !SUBREDDIT_STATUSES.has(subreddit.status)) {
      throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 目录名或状态无效，未写入任何文件。");
    }
    if (canonicalName !== displayName.toLowerCase()) {
      throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit canonicalName 与显示名不一致，未写入任何文件。");
    }
    if (names.has(canonicalName) || slugs.has(slug)) {
      throw new SubredditRegistryError("SUBREDDIT_REGISTRY_SCHEMA_INVALID", "subreddit 登记表存在重复名称或目录名，未写入任何文件。");
    }
    names.add(canonicalName);
    slugs.add(slug);
    return {
      collectionId: collection.collectionId,
      collectionName: collection.name,
      subreddit: displayName,
      canonicalName,
      slug,
      category,
      status: subreddit.status
    };
  });
}

export function parseSubredditRegistry(jsonText) {
  const registry = parseJson(jsonText);
  return { registry, collection: collectionFromRegistry(registry), entries: registryEntries(registry) };
}

export function registerSubredditInRegistry(jsonText, { subreddit, category = "manual" } = {}) {
  const displayName = requiredValue(
    normaliseSubredditName(subreddit),
    "SUBREDDIT_NAME_UNAVAILABLE",
    "无法从当前 Reddit 页面读取可靠的 subreddit 名称，未写入任何文件。"
  );
  const canonicalName = canonicalSubredditName(displayName);
  const slug = requiredValue(
    canonicalSlugForSubreddit(displayName),
    "SUBREDDIT_SLUG_UNAVAILABLE",
    "当前 subreddit 名称无法生成安全目录名，未写入任何文件。"
  );
  const parsed = parseSubredditRegistry(jsonText);
  const existing = parsed.entries.find((entry) => entry.canonicalName === canonicalName);
  if (existing) return { json: String(jsonText || ""), changed: false, entry: existing };
  const collision = parsed.entries.find((entry) => entry.slug === slug);
  if (collision) {
    throw new SubredditRegistryError(
      "SUBREDDIT_SLUG_CONFLICT",
      `自动生成的目录名“${slug}”已属于 r/${collision.subreddit}，未写入任何文件。`
    );
  }

  const entry = {
    collectionId: parsed.collection.collectionId,
    collectionName: parsed.collection.name,
    subreddit: displayName,
    canonicalName,
    slug,
    category: String(category || "manual").trim() || "manual",
    status: "active"
  };
  const registry = JSON.parse(JSON.stringify(parsed.registry));
  registry.subreddits.push({
    subreddit: entry.subreddit,
    canonicalName: entry.canonicalName,
    slug: entry.slug,
    category: entry.category,
    historicNames: [],
    status: entry.status
  });
  return { json: `${JSON.stringify(registry, null, 2)}\n`, changed: true, entry };
}
