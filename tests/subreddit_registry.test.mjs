import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SubredditRegistryError,
  canonicalSlugForSubreddit,
  canonicalSubredditName,
  parseSubredditRegistry,
  registerSubredditInRegistry
} from "../subreddit-registry.mjs";

const registryPath = new URL("./fixtures/subreddit_registry.json", import.meta.url);

test("the bundled synthetic registry is parseable without the local data workspace", async () => {
  const json = await readFile(registryPath, "utf8");
  const parsed = parseSubredditRegistry(json);
  assert.equal(parsed.collection.collectionId, "fixture-collection");
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries.find((entry) => entry.canonicalName === "mixed_reality")?.slug, "mixed-reality");
});

test("canonicalises Reddit names and safe directory slugs", () => {
  assert.equal(canonicalSubredditName("r/VRGaming"), "vrgaming");
  assert.equal(canonicalSubredditName("https://www.reddit.com/r/VRGaming"), "vrgaming");
  assert.equal(canonicalSlugForSubreddit("rokid_official"), "rokid-official");
  assert.equal(canonicalSubredditName("r/not valid"), null);
});

test("automatically registers only a new manually opened subreddit", () => {
  const fixture = JSON.stringify({
    schemaVersion: 1,
    collection: { collectionId: "vr-xr", name: "VR-XR", kind: "collection", historicNames: [] },
    subreddits: [{
      subreddit: "VRGaming", canonicalName: "vrgaming", slug: "vrgaming", category: "xr-ecosystem", historicNames: [], status: "active"
    }]
  });
  const result = registerSubredditInRegistry(fixture, { subreddit: "NewXR", category: "manual" });
  assert.equal(result.changed, true);
  assert.equal(result.entry.canonicalName, "newxr");
  assert.equal(JSON.parse(result.json).subreddits.length, 2);
  assert.equal(registerSubredditInRegistry(result.json, { subreddit: "r/NewXR" }).changed, false);
});

test("rejects a conflicting slug and invalid subreddit source", () => {
  const fixture = JSON.stringify({
    schemaVersion: 1,
    collection: { collectionId: "vr-xr", name: "VR-XR", kind: "collection", historicNames: [] },
    subreddits: [{
      subreddit: "foo_bar", canonicalName: "foo_bar", slug: "foo-bar", category: "manual", historicNames: [], status: "active"
    }]
  });
  assert.throws(
    () => registerSubredditInRegistry(fixture, { subreddit: "foo-bar" }),
    (error) => error instanceof SubredditRegistryError && error.code === "SUBREDDIT_NAME_UNAVAILABLE"
  );
  assert.throws(
    () => parseSubredditRegistry(JSON.stringify({ schemaVersion: 1, collection: { collectionId: "x", name: "X", kind: "collection" }, subreddits: [{
      subreddit: "foo_bar", canonicalName: "foo_bar", slug: "foo-bar", category: "manual", status: "active"
    }, {
      subreddit: "foo-bar", canonicalName: "foo-bar", slug: "foo-bar", category: "manual", status: "active"
    }] })),
    (error) => error instanceof SubredditRegistryError
  );
});
