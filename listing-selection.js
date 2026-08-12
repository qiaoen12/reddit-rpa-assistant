(() => {
  function postFullname(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (/^t3_[a-z0-9]+$/.test(raw)) return raw;
    if (/^[a-z0-9]+$/.test(raw)) return `t3_${raw}`;
    return null;
  }

  function recordFullname(record) {
    return postFullname(record?.post?.fullname || record?.post_fullname || record?.fullname);
  }

  function knownPostFullnames(posts) {
    const fullnames = new Set();
    for (const post of posts || []) {
      const fullname = typeof post === "string" ? postFullname(post) : recordFullname(post);
      if (fullname) fullnames.add(fullname);
    }
    return fullnames;
  }

  function selectUnseenRecords(records, knownPosts, limit) {
    const known = knownPostFullnames(knownPosts instanceof Set ? [...knownPosts] : knownPosts);
    const unseen = [];
    const seenInListing = new Set();
    let scannedPostCount = 0;
    let skippedExistingCount = 0;
    let duplicateListingCount = 0;
    let invalidPostCount = 0;
    for (const record of records || []) {
      const fullname = recordFullname(record);
      if (!fullname) {
        invalidPostCount += 1;
        continue;
      }
      scannedPostCount += 1;
      if (seenInListing.has(fullname)) {
        duplicateListingCount += 1;
        continue;
      }
      seenInListing.add(fullname);
      if (known.has(fullname)) {
        skippedExistingCount += 1;
        continue;
      }
      unseen.push(record);
    }
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 0));
    const selected = unseen.slice(0, safeLimit);
    return {
      records: selected,
      scanned_post_count: scannedPostCount,
      skipped_existing_count: skippedExistingCount,
      duplicate_listing_count: duplicateListingCount,
      invalid_post_count: invalidPostCount,
      available_new_count: unseen.length,
      selected_new_count: selected.length
    };
  }

  globalThis.RedditRpaListingSelection = { postFullname, knownPostFullnames, selectUnseenRecords };
})();
