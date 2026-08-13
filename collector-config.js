(() => {
  // 此文件同时被 classic content script 和 ES module popup 加载，故只暴露只读契约，
  // 不依赖 import/export、Chrome API 或页面 DOM。
  const DEFAULT_CONFIG = Object.freeze({
    listingSteps: 25,
    targetPostCount: 25,
    maxPosts: 25,
    scrollPercent: 85,
    waitMs: 1500,
    expansionPasses: 10,
    navigationJitterMs: 750,
    progressTimeoutMs: 45000,
    navigationTimeoutMs: 60000,
    rateLimitCooldownMs: 60000
  });

  globalThis.RedditRpaCollectorConfig = Object.freeze({ DEFAULT_CONFIG });
})();
