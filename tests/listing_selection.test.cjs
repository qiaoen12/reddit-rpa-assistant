const assert = require("node:assert/strict");
const test = require("node:test");

require("../listing-selection.js");
const selection = globalThis.RedditRpaListingSelection;

test("selects the requested unseen posts without changing current-list order", () => {
  const known = selection.knownPostFullnames(["t3_seen", { post: { fullname: "t3_already" } }]);
  const result = selection.selectUnseenRecords([
    { fullname: "t3_seen", title: "Seen" },
    { fullname: "t3_newone", title: "New one" },
    { fullname: "t3_already", title: "Already" },
    { fullname: "t3_newtwo", title: "New two" },
    { fullname: "t3_newthree", title: "New three" }
  ], known, 2);

  assert.deepEqual(result.records.map((record) => record.fullname), ["t3_newone", "t3_newtwo"]);
  assert.equal(result.scanned_post_count, 5);
  assert.equal(result.skipped_existing_count, 2);
  assert.equal(result.available_new_count, 3);
  assert.equal(result.selected_new_count, 2);
});

test("normalises t3 identities and never queues a duplicate listing row", () => {
  const result = selection.selectUnseenRecords([
    { fullname: "NEW" },
    { fullname: "t3_new" },
    { fullname: "t3_seen" },
    { fullname: "not a reddit id" }
  ], new Set(["T3_SEEN"]), 25);

  assert.deepEqual(result.records.map((record) => record.fullname), ["NEW"]);
  assert.equal(result.skipped_existing_count, 1);
  assert.equal(result.duplicate_listing_count, 1);
  assert.equal(result.invalid_post_count, 1);
});
