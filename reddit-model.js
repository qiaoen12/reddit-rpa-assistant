(() => {
  const RECORD_TYPES = new Set(["post", "comment"]);
  const EXPANSION_CONTROL_LABEL = /(?:\b(?:more comments|more replies|load more(?: comments| replies)?|view more comments|view more replies)\b|更多(?:评论|評論|回复|回覆)|(?:加载|載入|显示|顯示|查看|檢視)更多(?:评论|評論|回复|回覆)?|另外\s*\d+\s*[条條](?:回复|回覆))/iu;
  const CONTINUATION_THREAD_LABEL = /(?:\bcontinue this thread\b|继续此(?:讨论|评论)串|繼續此(?:討論|評論)串)/iu;
  const DELETED_PLACEHOLDER_LABEL = /(?:^|\s)(?:\[?(?:deleted|已删除|已刪除)\]?|(?:评论|評論|comment).{0,12}(?:deleted|已删除|已刪除)|用户.{0,12}(?:删除|刪除))/iu;
  const REMOVED_PLACEHOLDER_LABEL = /(?:^|\s)(?:\[?(?:removed|已移除)\]?|(?:评论|評論|comment).{0,12}(?:removed|已移除)|(?:版主|moderator).{0,12}(?:移除|removed))/iu;

  function asText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function isExpansionControlLabel(value) {
    return EXPANSION_CONTROL_LABEL.test(asText(value));
  }

  function isContinuationThreadLabel(value) {
    return CONTINUATION_THREAD_LABEL.test(asText(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function normaliseSubreddit(value) {
    let raw = asText(value).replace(/^https?:\/\/(?:www\.)?reddit\.com/i, "");
    raw = raw.replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, "");
    return /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/.test(raw) ? raw : null;
  }

  function parseRedditUrl(value) {
    let url;
    try {
      url = new URL(value, "https://www.reddit.com");
    } catch {
      return { pageType: "unknown", subreddit: null, postId: null, commentId: null, canonicalUrl: null };
    }
    const match = url.pathname.match(/^\/r\/([^/]+)(?:\/comments\/([a-z0-9]+)(?:\/[^/]+(?:\/([a-z0-9]+))?)?)?/i);
    if (!match) return { pageType: "unknown", subreddit: null, postId: null, commentId: null, canonicalUrl: url.href };
    return {
      pageType: match[2] ? "thread" : "listing",
      subreddit: normaliseSubreddit(match[1]),
      postId: match[2] || null,
      commentId: match[3] || null,
      canonicalUrl: `${url.origin}${url.pathname}`
    };
  }

  function canonicalPostUrl(value, expectedPostId = null) {
    let url;
    try {
      url = new URL(value, "https://www.reddit.com");
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !["reddit.com", "www.reddit.com"].includes(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    if (commentsIndex < 0) return null;
    const subreddit = normaliseSubreddit(segments[1]);
    const postId = String(segments[commentsIndex + 1] || "").toLowerCase();
    const urlSlug = String(segments[commentsIndex + 2] || "");
    const wantedPostId = shortId(expectedPostId, "t3") || String(expectedPostId || "").replace(/^t3_/i, "").toLowerCase();
    if (!subreddit || !/^[a-z0-9]+$/i.test(postId) || !urlSlug || urlSlug.toLowerCase() === "comment") return null;
    if (wantedPostId && postId !== wantedPostId) return null;
    return `${url.origin}/r/${subreddit}/comments/${postId}/${urlSlug}/`;
  }

  function postPermalinkForPost(candidates, postFullname, fallback = null) {
    for (const candidate of candidates || []) {
      const canonicalUrl = canonicalPostUrl(candidate, postFullname);
      if (canonicalUrl) return canonicalUrl;
    }
    return canonicalPostUrl(fallback, postFullname);
  }

  function postPermalinkIssue(value, postFullname, expectedSubreddit = null) {
    const parsed = parseRedditUrl(value);
    const expectedPostId = shortId(postFullname, "t3");
    if (!parsed.postId) return "POST_PERMALINK_UNAVAILABLE";
    if (expectedPostId && parsed.postId.toLowerCase() !== expectedPostId) return "POST_PERMALINK_MISMATCH";
    if (!canonicalPostUrl(value, postFullname)) return "POST_PERMALINK_UNAVAILABLE";
    const expected = normaliseSubreddit(expectedSubreddit);
    if (expected && parsed.subreddit?.toLowerCase() !== expected.toLowerCase()) return "POST_SUBREDDIT_MISMATCH";
    return null;
  }

  function fullname(value, prefix) {
    const raw = asText(value);
    if (!raw) return null;
    if (new RegExp(`^${prefix}_[A-Za-z0-9]+$`, "i").test(raw)) return raw.toLowerCase();
    if (/^[A-Za-z0-9]+$/.test(raw)) return `${prefix}_${raw.toLowerCase()}`;
    return null;
  }

  function shortId(value, prefix) {
    const valueFullname = fullname(value, prefix);
    return valueFullname ? valueFullname.slice(prefix.length + 1) : null;
  }

  function stableHash(value) {
    let hash = 2166136261;
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  // Reddit 的 shreddit-comment 使用「祖先位置路径 + 当前同级位置」表达
  // 评论树。它不是视觉缩进：例如根评论为 [] + 0，第一条回复为 [0] + 0。
  // 只接受严格的非负整数路径，无法证明时返回 null，让调用方保留 unknown。
  function nativeCommentParentPositions(value) {
    let positions = value;
    if (typeof positions === "string") {
      try {
        positions = JSON.parse(positions);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(positions)) return null;
    const normalised = positions.map((position) => Number(position));
    return normalised.every((position) => Number.isInteger(position) && position >= 0) ? normalised : null;
  }

  function nativeCommentPath(parentPositions, commentPosition) {
    const parents = nativeCommentParentPositions(parentPositions);
    const position = Number(commentPosition);
    if (!parents || !Number.isInteger(position) || position < 0) return null;
    return [...parents, position];
  }

  function nativeCommentPathKey(path) {
    return Array.isArray(path) ? path.join("/") : null;
  }

  function nativePlaceholderKind(value) {
    const text = asText(value);
    if (!text) return null;
    if (DELETED_PLACEHOLDER_LABEL.test(text)) return "deleted";
    if (REMOVED_PLACEHOLDER_LABEL.test(text)) return "removed";
    return null;
  }

  // 返回「当前 DOM 节点索引 -> 已证实的 t1_* 父级」。同一路径若有不同
  // 评论 ID，会被视为歧义，不做猜测。调用方仍会通过 validateCommentParents
  // 再次确认父级确实属于同一帖子。
  function resolveNativeCommentParents(items = []) {
    const descriptors = (items || []).map((item, index) => ({
      index,
      fullname: fullname(item?.fullname, "t1"),
      parentPositions: nativeCommentParentPositions(item?.parentPositions),
      path: nativeCommentPath(item?.parentPositions, item?.commentPosition)
    }));
    const byPath = new Map();
    const ambiguousPaths = new Set();
    for (const item of descriptors) {
      const key = nativeCommentPathKey(item.path);
      if (!item.fullname || !key) continue;
      const existing = byPath.get(key);
      if (existing && existing !== item.fullname) ambiguousPaths.add(key);
      else byPath.set(key, item.fullname);
    }
    const resolved = new Map();
    for (const item of descriptors) {
      const parentKey = nativeCommentPathKey(item.parentPositions);
      if (!item.fullname || !item.parentPositions?.length || !parentKey || ambiguousPaths.has(parentKey)) continue;
      const parent = byPath.get(parentKey);
      if (parent && parent !== item.fullname) resolved.set(item.index, parent);
    }
    return resolved;
  }

  // 删除占位没有 t1_* 身份，不能进入 Comment 快照。这里仅按 Reddit
  // 原生位置路径记录它是否刚好位于一个无法映射父级的子 Comment 上方；
  // 不读取 CSS 缩进，也不把视觉相邻节点当成父级。
  function diagnoseNativeCommentTree(items = [], { collapsedPlaceholderCount = 0 } = {}) {
    const descriptors = (items || []).map((item, index) => ({
      index,
      fullname: fullname(item?.fullname, "t1"),
      parentPositions: nativeCommentParentPositions(item?.parentPositions),
      path: nativeCommentPath(item?.parentPositions, item?.commentPosition),
      placeholder: nativePlaceholderKind(item?.placeholderText || item?.text || "")
    }));
    const byPath = new Map();
    const ambiguousPaths = new Set();
    for (const descriptor of descriptors) {
      const key = nativeCommentPathKey(descriptor.path);
      if (!key || (!descriptor.fullname && !descriptor.placeholder)) continue;
      const existing = byPath.get(key);
      if (existing) ambiguousPaths.add(key);
      else byPath.set(key, descriptor);
    }
    const parentReasons = new Map();
    let deletedPlaceholderCount = 0;
    let removedPlaceholderCount = 0;
    let unmappedNativeParentPathCount = 0;
    let deletedAncestorObserved = false;
    let removedAncestorObserved = false;
    for (const descriptor of descriptors) {
      if (descriptor.placeholder === "deleted") deletedPlaceholderCount += 1;
      if (descriptor.placeholder === "removed") removedPlaceholderCount += 1;
      const parentKey = nativeCommentPathKey(descriptor.parentPositions);
      if (!descriptor.fullname || !descriptor.parentPositions?.length || !parentKey) continue;
      const parent = ambiguousPaths.has(parentKey) ? null : byPath.get(parentKey);
      if (parent?.fullname) continue;
      unmappedNativeParentPathCount += 1;
      if (parent?.placeholder === "deleted") {
        parentReasons.set(descriptor.index, "deleted_ancestor_observed");
        deletedAncestorObserved = true;
      } else {
        parentReasons.set(descriptor.index, "parent_id_unavailable");
        if (parent?.placeholder === "removed") removedAncestorObserved = true;
      }
    }
    const reasonCodes = [];
    if (deletedPlaceholderCount) reasonCodes.push("DELETED_PLACEHOLDER_OBSERVED");
    if (removedPlaceholderCount) reasonCodes.push("REMOVED_PLACEHOLDER_OBSERVED");
    if (deletedAncestorObserved) reasonCodes.push("DELETED_ANCESTOR_OBSERVED");
    if (removedAncestorObserved) reasonCodes.push("REMOVED_ANCESTOR_OBSERVED");
    if (unmappedNativeParentPathCount) reasonCodes.push("UNMAPPED_NATIVE_PARENT_PATH");
    const collapsedCount = Math.max(0, Math.floor(Number(collapsedPlaceholderCount) || 0));
    if (collapsedCount) reasonCodes.push("COLLAPSED_COMMENT_CONTROL");
    return {
      parentReasons,
      treeDiagnostics: {
        deleted_placeholder_count: deletedPlaceholderCount,
        removed_placeholder_count: removedPlaceholderCount,
        collapsed_placeholder_count: collapsedCount,
        unmapped_native_parent_path_count: unmappedNativeParentPathCount,
        reason_codes: reasonCodes
      }
    };
  }

  function commonRecord(input, recordType, entityFullname, entityId) {
    const capturedAt = input.capturedAt || nowIso();
    const subreddit = normaliseSubreddit(input.subreddit);
    const canonicalUrl = asText(input.canonicalUrl) || null;
    const title = asText(input.title);
    const content = asText(input.content);
    return {
      id: entityId,
      fullname: entityFullname,
      record_type: recordType,
      title,
      content,
      source_id: subreddit ? `r/${subreddit.toLowerCase()}` : null,
      source_name: subreddit ? `r/${subreddit}` : null,
      source_url: canonicalUrl,
      source_url_or_raw_path: canonicalUrl,
      canonical_url: canonicalUrl,
      fetched_at: capturedAt,
      published_at: input.publishedAt || null,
      updated_at: input.updatedAt || null,
      language: asText(input.language) || "unknown",
      categories: Array.isArray(input.categories) ? input.categories : [],
      content_hash: stableHash(JSON.stringify([recordType, entityFullname, title, content, canonicalUrl, input.publishedAt || null])),
      confidence: "source-dom",
      unsupported_fields: {},
      errors: input.errors || null,
      subreddit,
      author: asText(input.author) || null,
      author_url: asText(input.authorUrl) || null,
      edited: Boolean(input.edited),
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      captured_at: capturedAt,
      extractor: input.extractor || "reddit-rpa-dom-v1"
    };
  }

  function makePostRecord(input = {}) {
    const postFullname = fullname(input.fullname || input.postFullname || input.postId, "t3");
    if (!postFullname) return null;
    const postId = shortId(postFullname, "t3");
    return {
      ...commonRecord(input, "post", postFullname, postId),
      post_id: postId,
      post_fullname: postFullname,
      parent_fullname: null,
      depth: 0,
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : null
    };
  }

  function makeCommentRecord(input = {}) {
    const commentFullname = fullname(input.fullname || input.commentFullname || input.commentId, "t1");
    const postFullname = fullname(input.postFullname || input.postId, "t3");
    if (!commentFullname || !postFullname) return null;
    const hasExplicitParent = Object.hasOwn(input, "parentFullname");
    const suppliedParent = fullname(input.parentFullname, "t1") || fullname(input.parentFullname, "t3");
    const parentFullname = suppliedParent || (hasExplicitParent ? null : postFullname);
    const fallbackDepth = parentFullname?.startsWith("t1_") ? 1 : 0;
    const depthValue = Number(input.depth);
    const depth = Number.isInteger(depthValue) && depthValue >= 0 ? depthValue : fallbackDepth;
    return {
      ...commonRecord(input, "comment", commentFullname, shortId(commentFullname, "t1")),
      post_id: shortId(postFullname, "t3"),
      post_fullname: postFullname,
      parent_fullname: parentFullname,
      depth,
      parent_status: asText(input.parentStatus) || (parentFullname ? "unverified" : "unknown"),
      parent_reason: asText(input.parentReason) || (parentFullname ? "verified_attribute" : "parent_id_unavailable"),
      ownership_verified: Boolean(input.ownershipVerified),
      ownership_method: asText(input.ownershipMethod) || null,
      score: Number.isFinite(Number(input.score)) ? Number(input.score) : null
    };
  }

  function validateCommentParents(records, expectedPostFullname) {
    const postFullname = fullname(expectedPostFullname, "t3");
    const comments = (records || []).filter((record) => record?.record_type === "comment");
    const knownComments = new Set(comments
      .filter((record) => fullname(record.post_fullname, "t3") === postFullname)
      .map((record) => fullname(record.fullname, "t1"))
      .filter(Boolean));
    function unknownParent(record) {
      return {
        ...record,
        parent_fullname: null,
        depth: null,
        parent_status: "unknown",
        parent_reason: record.parent_reason === "deleted_ancestor_observed"
          ? "deleted_ancestor_observed"
          : "parent_id_unavailable"
      };
    }
    function verifiedParent(record, parentFullname) {
      return {
        ...record,
        parent_fullname: parentFullname,
        parent_status: "verified",
        parent_reason: record.parent_reason === "verified_native_position"
          ? "verified_native_position"
          : "verified_attribute"
      };
    }
    const normalised = comments.map((record) => {
      const commentFullname = fullname(record.fullname, "t1");
      const recordPost = fullname(record.post_fullname, "t3");
      const parentComment = fullname(record.parent_fullname, "t1");
      const parentPost = fullname(record.parent_fullname, "t3");
      if (!postFullname || !commentFullname || recordPost !== postFullname) {
        return unknownParent(record);
      }
      if (parentPost === postFullname) {
        return verifiedParent(record, postFullname);
      }
      if (parentComment && parentComment !== commentFullname && knownComments.has(parentComment)) {
        return verifiedParent(record, parentComment);
      }
      return unknownParent(record);
    });
    const byFullname = new Map(normalised.map((record) => [fullname(record.fullname, "t1"), record]).filter(([id]) => id));
    const cache = new Map();
    const resolving = new Set();
    function depthFor(commentFullname) {
      if (cache.has(commentFullname)) return cache.get(commentFullname);
      if (resolving.has(commentFullname)) return null;
      resolving.add(commentFullname);
      const record = byFullname.get(commentFullname);
      let depth = null;
      if (record?.parent_status === "verified") {
        if (record.parent_fullname === postFullname) depth = 0;
        else if (String(record.parent_fullname || "").startsWith("t1_")) {
          const parentDepth = depthFor(record.parent_fullname);
          if (Number.isInteger(parentDepth)) depth = parentDepth + 1;
        }
      }
      resolving.delete(commentFullname);
      cache.set(commentFullname, depth);
      return depth;
    }
    return normalised.map((record) => {
      const commentFullname = fullname(record.fullname, "t1");
      const depth = commentFullname ? depthFor(commentFullname) : null;
      if (!Number.isInteger(depth)) return unknownParent(record);
      return { ...record, depth };
    });
  }

  function preferredRecord(current, candidate) {
    if (!current) return candidate;
    const currentContent = asText(current.content).length;
    const candidateContent = asText(candidate.content).length;
    const merged = { ...current, ...candidate };
    if (currentContent > candidateContent) merged.content = current.content;
    if (!candidate.title && current.title) merged.title = current.title;
    if (!candidate.author && current.author) merged.author = current.author;
    if (!candidate.author_url && current.author_url) merged.author_url = current.author_url;
    if (!candidate.published_at && current.published_at) merged.published_at = current.published_at;
    if (!candidate.canonical_url && current.canonical_url) {
      merged.canonical_url = current.canonical_url;
      merged.source_url = current.source_url;
      merged.source_url_or_raw_path = current.source_url_or_raw_path;
    }
    merged.attachments = [...new Set([...(current.attachments || []), ...(candidate.attachments || [])])];
    merged.last_seen_at = candidate.captured_at || current.captured_at;
    return merged;
  }

  function mergeRecords(records) {
    const byFullname = new Map();
    for (const record of records || []) {
      if (!record || !RECORD_TYPES.has(record.record_type) || !record.fullname) continue;
      byFullname.set(record.fullname, preferredRecord(byFullname.get(record.fullname), record));
    }
    return [...byFullname.values()].sort((left, right) => {
      if (left.record_type !== right.record_type) return left.record_type === "post" ? -1 : 1;
      const leftTime = left.published_at || left.captured_at || "";
      const rightTime = right.published_at || right.captured_at || "";
      return leftTime.localeCompare(rightTime) || left.fullname.localeCompare(right.fullname);
    });
  }

  function qualitySummary(records, { continuationUrls = [], unexpandedControls = [] } = {}) {
    const merged = mergeRecords(records);
    const comments = merged.filter((record) => record.record_type === "comment");
    return {
      record_count: merged.length,
      post_count: merged.filter((record) => record.record_type === "post").length,
      comment_count: comments.length,
      missing_author: merged.filter((record) => !record.author).length,
      missing_permalink: merged.filter((record) => !record.canonical_url).length,
      missing_parent_comment: comments.filter((record) => !record.parent_fullname).length,
      unknown_parent_comment: comments.filter((record) => record.parent_status !== "verified").length,
      self_parent_comment: comments.filter((record) => record.parent_fullname === record.fullname).length,
      duplicate_fullnames: Math.max(0, (records || []).length - merged.length),
      continuation_urls: [...new Set(continuationUrls)],
      unexpanded_controls: [...new Set(unexpandedControls)]
    };
  }

  function finiteCount(value) {
    return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  }

  // A rendered 0/0 can be a real empty thread, but Reddit can also briefly show
  // it while the comment component is still hydrating. The caller performs one
  // bounded second read before it treats that state as complete.
  function shouldRecheckZeroCommentCapture({ reportedCommentCount, collectedCommentCount } = {}) {
    return finiteCount(reportedCommentCount) === 0 && Number(collectedCommentCount) === 0;
  }

  function classifyThreadCoverage({ reportedCommentCount, collectedCommentCount, visibleCommentCount = null, unexpandedControls = [], unknownParentComment = 0 } = {}) {
    const reportedCommentCountValue = finiteCount(reportedCommentCount);
    const collectedCommentCountValue = Math.max(0, Number(collectedCommentCount) || 0);
    const visibleCommentCountValue = finiteCount(visibleCommentCount);
    const commentCountGap = reportedCommentCountValue == null ? null : reportedCommentCountValue - collectedCommentCountValue;
    const retryReasons = [];
    const treeReasons = [];
    if (Array.isArray(unexpandedControls) && unexpandedControls.length) retryReasons.push("仍有未展开的评论控件");
    const visibleSnapshotMatches = visibleCommentCountValue != null && visibleCommentCountValue === collectedCommentCountValue;
    // Reddit 的头部总数会包含已删除或当前不可见的评论。只有当前页面所有
    // 原生 shreddit-comment 都已通过 t1/permalink 验证时，才允许把正向差异
    // 记录为审计差异而非重复采集；0 条或任何未验证节点仍按缺口处理。
    const nonBlockingReportedCountGap = commentCountGap !== null
      && commentCountGap > 0
      && collectedCommentCountValue > 0
      && visibleSnapshotMatches;
    if (commentCountGap !== null && commentCountGap !== 0 && !nonBlockingReportedCountGap) {
      retryReasons.push("页面评论数与已采集数不一致");
    }
    if (Number(unknownParentComment) > 0) treeReasons.push("存在无法确认父级的评论");
    const retryable = retryReasons.length > 0;
    const treePartial = !retryable && treeReasons.length > 0;
    const status = retryable
      ? "retry"
      : treePartial
        ? "tree_partial"
        : nonBlockingReportedCountGap
          ? "complete_with_reported_count_gap"
          : "complete";
    return {
      complete: !retryable && !treePartial,
      retryable,
      tree_partial: treePartial,
      status,
      reasons: [...retryReasons, ...treeReasons],
      retry_reasons: retryReasons,
      tree_reasons: treeReasons,
      reported_comment_count: reportedCommentCountValue,
      visible_comment_count: visibleCommentCountValue,
      visible_snapshot_matches: visibleSnapshotMatches,
      comment_count_gap: commentCountGap,
      reported_count_gap_is_non_blocking: nonBlockingReportedCountGap
    };
  }

  globalThis.RedditRpaModel = {
    asText,
    isExpansionControlLabel,
    isContinuationThreadLabel,
    nowIso,
    normaliseSubreddit,
    parseRedditUrl,
    canonicalPostUrl,
    postPermalinkForPost,
    postPermalinkIssue,
    fullname,
    shortId,
    stableHash,
    nativeCommentParentPositions,
    nativeCommentPath,
    resolveNativeCommentParents,
    nativePlaceholderKind,
    diagnoseNativeCommentTree,
    makePostRecord,
    makeCommentRecord,
    validateCommentParents,
    mergeRecords,
    qualitySummary,
    shouldRecheckZeroCommentCapture,
    classifyThreadCoverage
  };
})();
