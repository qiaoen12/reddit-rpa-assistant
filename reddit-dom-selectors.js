(() => {
  globalThis.RedditRpaDomSelectors = Object.freeze({
    postNodes: Object.freeze([
      "shreddit-post",
      '[id^="t3_"]',
      '[thingid^="t3_"]',
      '[data-fullname^="t3_"]',
      '[data-testid="post-container"]'
    ]),
    commentNodes: Object.freeze([
      "shreddit-comment",
      '[id^="t1_"]',
      '[thingid^="t1_"]',
      '[data-fullname^="t1_"]'
    ]),
    postTitle: Object.freeze(['[slot="title"]', 'a[slot="title"]', '[data-testid="post-title"]']),
    postContent: Object.freeze([
      '[slot="text-body"]',
      "shreddit-post-text-body",
      '[data-testid="post-content"]',
      '[data-click-id="text"]',
      '[data-click-id="body"]'
    ]),
    commentContent: Object.freeze([
      '[slot="comment"]',
      "shreddit-comment-body",
      '[data-testid="comment-content"]',
      '[data-testid="comment"]'
    ]),
    commentParentAttributes: Object.freeze(["parent-fullname", "data-parent-fullname", "parent-id", "data-parent-id"]),
    commentPostAttributes: Object.freeze(["post-fullname", "data-post-fullname", "post-id", "data-post-id", "link-id", "data-link-id"])
  });
})();
