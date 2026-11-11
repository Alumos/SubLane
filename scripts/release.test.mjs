import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseMetadata, isLatestStable } from "./release.mjs";

test("normalizes stable and prerelease tags without changing their versions", () => {
  assert.deepEqual(releaseMetadata("v1.2.3", "Example-Team/SubLane"), {
    tag: "v1.2.3",
    version: "1.2.3",
    prerelease: false,
    image: "ghcr.io/example-team/sublane",
  });
  assert.equal(releaseMetadata("v0.1.0-rc.1", "owner/repo").prerelease, true);
});

test("rejects ambiguous or unsafe release labels before publishing", () => {
  for (const tag of [
    "main",
    "v1.2",
    "v01.2.3",
    "v1.2.3-01",
    "v1.2.3-rc..1",
    "v1.2.3+build",
    "v1.2.3\nlatest=true",
    "v1.2.3\n",
    "v1.2.3\r",
    "v1.2.3;echo",
    "v1.2.3-",
  ]) {
    assert.throws(() => releaseMetadata(tag, "owner/repo"));
  }
  for (const repo of [
    "../repo",
    "owner/repo/extra",
    "owner/repo\nlatest=true",
    "owner/repo\n",
  ]) {
    assert.throws(() => releaseMetadata("v1.2.3", repo));
  }
});

test("keeps prereleases and older maintenance versions off the stable channel", () => {
  assert.equal(isLatestStable("v1.9.0", ["v1.10.0", "v1.9.0"]), false);
  assert.equal(
    isLatestStable("v1.10.0", ["v1.9.9", "v1.10.0", "v2.0.0-rc.1"]),
    true,
  );
  assert.equal(isLatestStable("v2.0.0-rc.1", ["v1.10.0"]), false);
  assert.equal(isLatestStable("v0.1.0", ["not-a-version", "v0.1.0"]), true);
});

test("treats fork revisions as stable and orders them after their base release", () => {
  assert.equal(releaseMetadata("v0.19.2-revised.8", "Alumos/SubLane").prerelease, false);
  assert.equal(releaseMetadata("v0.19.2-revised.8", "Alumos/SubLane").image, "ghcr.io/alumos/sublane");
  assert.equal(releaseMetadata("v0.19.2-rc.1", "Alumos/SubLane").prerelease, true);
  assert.equal(releaseMetadata("v0.19.2-revised.0", "Alumos/SubLane").prerelease, true);
  assert.equal(
    isLatestStable("v0.19.2-revised.10", ["v0.19.2", "v0.19.2-revised.9", "v0.19.2-revised.10"]),
    true,
  );
  assert.equal(isLatestStable("v0.19.2-revised.9", ["v0.19.2-revised.10"]), false);
  assert.equal(isLatestStable("v0.19.2", ["v0.19.2-revised.1"]), false);
  assert.equal(isLatestStable("v0.19.3", ["v0.19.2-revised.99"]), true);
});
