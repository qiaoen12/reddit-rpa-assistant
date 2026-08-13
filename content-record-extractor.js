(() => {
  function create({
    model,
    selectors,
    documentRef = globalThis.document,
    pageContext
  } = {}) {
    const { textOf, attributeOf, absoluteUrl, firstText } = pageContext || {};
    if (!model || !selectors?.postNodes || !selectors?.commentNodes || !documentRef?.querySelectorAll
      || typeof textOf !== "function" || typeof attributeOf !== "function"
      || typeof absoluteUrl !== "function" || typeof firstText !== "function") {
      throw new Error("页面记录提取依赖无效。");
    }

    function thingFullname(node, prefix) {
      const values = [
        attributeOf(node, ["id", "thingid", "data-fullname", "data-testid", "post-id", "comment-id"]),
        node?.id
      ];
      for (const value of values) {
        const exact = model.fullname(value, prefix);
        if (exact) return exact;
        const match = String(value || "").match(new RegExp(`(${prefix}_[A-Za-z0-9]+)`, "i"));
        if (match) return model.fullname(match[1], prefix);
      }
      for (const link of node?.querySelectorAll?.('a[href*="/comments/"]') || []) {
        const parsed = model.parseRedditUrl(link.href);
        const candidate = prefix === "t3" ? parsed.postId : parsed.commentId;
        const exact = model.fullname(candidate, prefix);
        if (exact) return exact;
      }
      return null;
    }

    function findAuthor(node) {
      const authorLink = node?.querySelector?.('a[href^="/user/"], a[href^="/u/"], a[href*="reddit.com/user/"], a[href*="reddit.com/u/"]');
      const author = model.asText(attributeOf(node, ["author", "data-author"]) || textOf(authorLink));
      return { author: author || null, authorUrl: absoluteUrl(authorLink?.href) };
    }

    function findTimestamp(node) {
      const time = node?.querySelector?.("time[datetime]");
      return time?.getAttribute("datetime") || attributeOf(node, ["created-timestamp", "created", "data-created-at"]) || null;
    }

    function findAttachments(node) {
      const values = new Set();
      for (const selector of ['a[href^="https://preview.redd.it/"]', 'a[href^="https://i.redd.it/"]', "img[src]", "video[src]", "source[src]"]) {
        for (const element of node?.querySelectorAll?.(selector) || []) {
          const candidate = absoluteUrl(element.href || element.currentSrc || element.src);
          if (candidate) values.add(candidate);
        }
      }
      return [...values].slice(0, 20);
    }

    function findScore(node) {
      const raw = attributeOf(node, ["score", "data-score"])
        || firstText(node, ['[slot="score"]', '[data-testid="post-score"]', '[data-testid="comment-score"]']);
      const match = String(raw || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }

    function localPostPermalinkCandidates(node) {
      return [
        attributeOf(node, ["permalink", "content-href", "data-permalink", "href"]),
        ...[...(node?.querySelectorAll?.('a[href*="/comments/"]') || [])].map((link) => link.href)
      ].filter(Boolean);
    }

    function postPermalink(node, context, postFullname) {
      return model.postPermalinkForPost(localPostPermalinkCandidates(node), postFullname, context?.post_fullname === postFullname ? context.canonical_url : null);
    }

    function postTitle(node, postFullname) {
      const title = attributeOf(node, ["post-title", "data-post-title"]);
      if (title) return title;
      const expectedPostId = model.shortId(postFullname, "t3");
      for (const link of node?.querySelectorAll?.('a[href*="/comments/"]') || []) {
        const parsed = model.parseRedditUrl(link.href);
        if (!expectedPostId || parsed.postId?.toLowerCase() !== expectedPostId) continue;
        const linkedTitle = model.asText(attributeOf(link, ["aria-label", "title"]) || textOf(link))
          .replace(/^list item post\s*-\s*/i, "");
        if (linkedTitle) return linkedTitle;
      }
      return firstText(node, selectors.postTitle);
    }

    function extractPostRecord(node, context) {
      const postFullname = thingFullname(node, "t3") || context.post_fullname;
      if (!postFullname) return null;
      const author = findAuthor(node);
      const title = postTitle(node, postFullname);
      return model.makePostRecord({
        fullname: postFullname,
        subreddit: context.subreddit,
        title,
        content: firstText(node, selectors.postContent),
        canonicalUrl: postPermalink(node, context, postFullname),
        author: author.author,
        authorUrl: author.authorUrl,
        publishedAt: findTimestamp(node),
        updatedAt: attributeOf(node, ["edited-timestamp", "updated-timestamp"]) || null,
        edited: Boolean(attributeOf(node, ["edited", "data-edited"])) || /\bedited\b/i.test(textOf(node?.querySelector?.('[data-testid*="edited"]'))),
        attachments: findAttachments(node),
        score: findScore(node),
        capturedAt: model.nowIso()
      });
    }

    function postFallbackRecord(context) {
      if (!context.post_fullname) return null;
      const documentNode = documentRef.documentElement;
      const author = findAuthor(documentNode);
      return model.makePostRecord({
        fullname: context.post_fullname,
        subreddit: context.subreddit,
        title: firstText(documentRef, ["h1", '[data-testid="post-title"]', 'shreddit-post [slot="title"]']),
        content: firstText(documentRef, ["shreddit-post-text-body", '[data-testid="post-content"]', '[data-click-id="text"]']),
        canonicalUrl: model.canonicalPostUrl(context.canonical_url, context.post_fullname),
        author: author.author,
        authorUrl: author.authorUrl,
        publishedAt: findTimestamp(documentNode),
        attachments: findAttachments(documentNode),
        capturedAt: model.nowIso()
      });
    }

    function postNodes() {
      const nodes = new Set();
      for (const selector of selectors.postNodes) {
        for (const node of documentRef.querySelectorAll(selector)) nodes.add(node);
      }
      return [...nodes];
    }

    function parentFullnameForComment(node, commentFullname) {
      const raw = attributeOf(node, selectors.commentParentAttributes);
      if (raw) {
        const parent = /^t1_/i.test(raw) ? model.fullname(raw, "t1") : /^t3_/i.test(raw) ? model.fullname(raw, "t3") : null;
        if (parent && parent !== commentFullname) return parent;
      }
      return null;
    }

    function declaredCommentDepth(node) {
      const raw = attributeOf(node, ["depth", "data-depth", "nesting-level"]);
      if (raw == null) return null;
      const numericDepth = Number(raw);
      if (Number.isInteger(numericDepth) && numericDepth >= 0) return numericDepth;
      return null;
    }

    function commentDepth(node, parentFullname) {
      const declared = declaredCommentDepth(node);
      if (declared != null) return declared;
      if (!parentFullname) return null;
      return parentFullname.startsWith("t1_") ? 1 : 0;
    }

    function commentPermalink(node, commentFullname) {
      const shortCommentId = model.shortId(commentFullname, "t1");
      for (const link of node?.querySelectorAll?.('a[href*="/comments/"]') || []) {
        const parsed = model.parseRedditUrl(link.href);
        if (parsed.commentId && parsed.commentId.toLowerCase() === shortCommentId) return parsed.canonicalUrl || absoluteUrl(link.href);
      }
      return null;
    }

    function commentOwnershipEvidence(node, context, commentFullname) {
      const permalink = commentPermalink(node, commentFullname);
      if (permalink) {
        const parsed = model.parseRedditUrl(permalink);
        if (parsed.postId && parsed.commentId
          && model.fullname(parsed.postId, "t3") === context.post_fullname
          && model.fullname(parsed.commentId, "t1") === commentFullname) {
          return { method: "comment_permalink", canonicalUrl: permalink };
        }
      }
      const owner = model.fullname(attributeOf(node, selectors.commentPostAttributes), "t3");
      if (owner && owner === context.post_fullname) {
        return { method: "comment_post_attribute", canonicalUrl: context.canonical_url };
      }
      return null;
    }

    function extractCommentRecord(node, context, nativeParentFullname = null, unknownParentReason = null) {
      const commentFullname = thingFullname(node, "t1");
      const postFullname = context.post_fullname || model.fullname(context.post_id, "t3");
      if (!commentFullname || !postFullname) return null;
      const ownership = commentOwnershipEvidence(node, context, commentFullname);
      if (!ownership) return null;
      const attributeParentFullname = parentFullnameForComment(node, commentFullname);
      const parentFullname = attributeParentFullname
        || nativeParentFullname
        || (declaredCommentDepth(node) === 0 ? postFullname : null);
      const parentReason = attributeParentFullname || declaredCommentDepth(node) === 0
        ? "verified_attribute"
        : nativeParentFullname
          ? "verified_native_position"
          : unknownParentReason || "parent_id_unavailable";
      const author = findAuthor(node);
      return model.makeCommentRecord({
        fullname: commentFullname,
        postFullname,
        parentFullname,
        parentReason,
        depth: commentDepth(node, parentFullname),
        subreddit: context.subreddit,
        title: "",
        content: firstText(node, selectors.commentContent),
        canonicalUrl: ownership.canonicalUrl,
        ownershipVerified: true,
        ownershipMethod: ownership.method,
        author: author.author,
        authorUrl: author.authorUrl,
        publishedAt: findTimestamp(node),
        updatedAt: attributeOf(node, ["edited-timestamp", "updated-timestamp"]) || null,
        edited: Boolean(attributeOf(node, ["edited", "data-edited"])) || /\bedited\b/i.test(textOf(node?.querySelector?.('[data-testid*="edited"]'))),
        attachments: findAttachments(node),
        score: findScore(node),
        capturedAt: model.nowIso()
      });
    }

    function nativeCommentNodes() {
      return [...documentRef.querySelectorAll("shreddit-comment")];
    }

    function commentNodes() {
      // 新版 Reddit 的原生评论主机最可靠：广告卡和其他旁路组件不会拥有它。
      // 旧布局没有该节点时，才退回兼容选择器。
      const native = nativeCommentNodes();
      if (native.length) return native;
      const nodes = new Set();
      for (const selector of selectors.commentNodes) {
        for (const node of documentRef.querySelectorAll(selector)) nodes.add(node);
      }
      return [...nodes];
    }

    function nativeCommentParentHints(nodes, collapsedPlaceholderCount = 0) {
      const descriptors = (nodes || []).map((node) => ({
        fullname: thingFullname(node, "t1"),
        parentPositions: attributeOf(node, ["comment-parent-positions"]),
        commentPosition: attributeOf(node, ["comment-position"]),
        placeholderText: model.asText(`${textOf(node)} ${attributeOf(node, ["aria-label", "title"]) || ""}`)
      }));
      const evidence = model.diagnoseNativeCommentTree(descriptors, { collapsedPlaceholderCount });
      return {
        parents: model.resolveNativeCommentParents(descriptors),
        parentReasons: evidence.parentReasons,
        treeDiagnostics: evidence.treeDiagnostics
      };
    }

    function mergeListingRecords(existing, incoming, limit = Number.POSITIVE_INFINITY) {
      const byFullname = new Map();
      for (const record of [...(existing || []), ...(incoming || [])]) {
        if (record?.record_type !== "post" || !record.fullname) continue;
        const current = byFullname.get(record.fullname);
        byFullname.set(record.fullname, current ? model.mergeRecords([current, record])[0] : record);
      }
      return [...byFullname.values()].slice(0, Math.max(1, limit));
    }

    function collectListing(context) {
      const records = [];
      const invalid = [];
      for (const node of postNodes()) {
        const record = extractPostRecord(node, context);
        if (!record) continue;
        const reason = model.postPermalinkIssue(record.canonical_url, record.fullname, context.subreddit);
        if (reason) {
          invalid.push({ fullname: record.fullname, title: record.title || "", reason });
        } else {
          records.push(record);
        }
      }
      const merged = mergeListingRecords([], records);
      return {
        records: merged,
        invalid_permalinks: [...new Map(invalid.map((item) => [`${item.fullname}:${item.reason}`, item])).values()]
      };
    }

    function collectThread(context, { collapsedPlaceholderCount = 0 } = {}) {
      const post = postNodes()
        .map((node) => extractPostRecord(node, context))
        .find((record) => record?.fullname === context.post_fullname) || postFallbackRecord(context);
      const nativeNodes = nativeCommentNodes();
      const candidates = nativeNodes.length ? nativeNodes : commentNodes();
      const parentHints = nativeCommentParentHints(candidates, collapsedPlaceholderCount);
      const comments = candidates.map((node, index) => extractCommentRecord(
        node,
        context,
        parentHints.parents.get(index) || null,
        parentHints.parentReasons.get(index) || null
      )).filter(Boolean);
      const nativeCommentFullnames = nativeNodes.length
        ? [...new Set(nativeNodes.map((node) => thingFullname(node, "t1")).filter(Boolean))]
        : null;
      return {
        records: model.mergeRecords([post, ...comments].filter(Boolean)),
        rejected_foreign_comment_count: Math.max(0, candidates.length - comments.length),
        native_comment_fullnames: nativeCommentFullnames,
        native_comment_node_count: nativeNodes.length,
        tree_diagnostics: parentHints.treeDiagnostics
      };
    }

    return Object.freeze({
      thingFullname,
      postNodes,
      collectListing,
      collectThread,
      mergeListingRecords
    });
  }

  // 记录提取边界：只把已渲染节点转换为经身份/归属验证的记录，不持有任务状态。
  globalThis.RedditRpaRecordExtractor = Object.freeze({ create });
})();
