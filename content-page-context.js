(() => {
  function create({
    model,
    documentRef = globalThis.document,
    locationRef = globalThis.location,
    URLCtor = globalThis.URL,
    collectionId = "vr-xr",
    collectionName = "VR-XR"
  } = {}) {
    if (typeof model?.asText !== "function" || typeof model?.parseRedditUrl !== "function" || typeof URLCtor !== "function") {
      throw new Error("页面上下文依赖无效。");
    }

    const pageLocation = () => String(locationRef?.href || "");

    function normalisedPageUrl(value = pageLocation()) {
      try {
        const url = new URLCtor(value, pageLocation());
        url.search = "";
        url.hash = "";
        return url.href.replace(/\/$/, "");
      } catch {
        return String(value || "");
      }
    }

    function textOf(node) {
      return model.asText(node?.innerText || node?.textContent || "");
    }

    function attributeOf(node, names = []) {
      for (const name of names) {
        const value = node?.getAttribute?.(name);
        if (value) return String(value);
      }
      return null;
    }

    function absoluteUrl(value) {
      if (!String(value || "").trim()) return null;
      try {
        const url = new URLCtor(value, pageLocation());
        return url.protocol === "https:" ? url.href : null;
      } catch {
        return null;
      }
    }

    function firstText(node, candidateSelectors = []) {
      for (const selector of candidateSelectors) {
        const text = textOf(node?.querySelector?.(selector));
        if (text) return text;
      }
      return "";
    }

    function subredditFromDocument() {
      const parsed = model.parseRedditUrl(pageLocation());
      if (parsed.subreddit) return parsed.subreddit;
      const candidates = documentRef?.querySelectorAll?.('a[href^="/r/"], a[href^="https://www.reddit.com/r/"]') || [];
      for (const candidate of candidates) {
        const matched = model.parseRedditUrl(candidate?.href);
        if (matched.subreddit) return matched.subreddit;
      }
      return null;
    }

    function currentContext() {
      const href = pageLocation();
      const parsed = model.parseRedditUrl(href);
      const subreddit = parsed.subreddit || subredditFromDocument();
      const canonicalPostUrl = parsed.postId ? model.canonicalPostUrl(href, parsed.postId) : null;
      return {
        collection_id: collectionId,
        collection_name: collectionName,
        page_type: parsed.pageType,
        subreddit,
        source_url: normalisedPageUrl(href),
        canonical_url: canonicalPostUrl || parsed.canonicalUrl || normalisedPageUrl(href),
        post_id: parsed.postId || null,
        post_fullname: parsed.postId ? model.fullname(parsed.postId, "t3") : null,
        comment_id: parsed.commentId || null,
        category: "manual"
      };
    }

    function contextsMatch(left, right) {
      return Boolean(left?.subreddit && right?.subreddit && left.subreddit.toLowerCase() === right.subreddit.toLowerCase());
    }

    function postContextsMatch(left, right) {
      return Boolean(contextsMatch(left, right) && left?.post_fullname && right?.post_fullname
        && left.post_fullname.toLowerCase() === right.post_fullname.toLowerCase());
    }

    function threadTargetContext(target, fallbackContext) {
      const post = target?.post || {};
      const postFullname = model.fullname(post.fullname || post.post_fullname || target?.post_fullname, "t3");
      const canonicalUrl = model.postPermalinkForPost(
        [target?.permalink, post.canonical_url, post.source_url, post.source_url_or_raw_path],
        postFullname
      );
      if (!postFullname || !canonicalUrl) throw new Error("批量目标缺少可验证的帖子代码或永久链接。");
      const parsed = model.parseRedditUrl(canonicalUrl);
      return {
        collection_id: collectionId,
        collection_name: collectionName,
        page_type: "thread",
        subreddit: parsed.subreddit || post.subreddit || fallbackContext?.subreddit || null,
        source_url: canonicalUrl,
        canonical_url: canonicalUrl,
        post_id: model.shortId(postFullname, "t3"),
        post_fullname: postFullname,
        comment_id: null,
        category: fallbackContext?.category || "manual"
      };
    }

    return Object.freeze({
      normalisedPageUrl,
      textOf,
      attributeOf,
      absoluteUrl,
      firstText,
      subredditFromDocument,
      currentContext,
      contextsMatch,
      postContextsMatch,
      threadTargetContext
    });
  }

  // 纯页面上下文规则：不持有采集状态、不访问 Chrome API，也不直接写入数据。
  globalThis.RedditRpaPageContext = Object.freeze({ create });
})();
