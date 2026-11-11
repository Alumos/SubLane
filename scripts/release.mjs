import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseMetadata(tag, repository) {
  const match =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag,
    );
  if (
    !match ||
    tag.length > 100 ||
    match[4]
      ?.split(".")
      .some(
        (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
      )
  ) {
    throw new Error(
      "Use a canonical version tag such as v1.2.3 or v1.2.3-rc.1; build metadata is not supported.",
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
  ) {
    throw new Error("Expected a GitHub owner/repository name.");
  }
  // Fork revisions (X.Y.Z-revised.N) are stable releases of this fork, not prereleases.
  const revision = /^revised\.([1-9]\d*)$/.exec(match[4] ?? "");
  return {
    tag,
    version: tag.slice(1),
    prerelease: Boolean(match[4]) && !revision,
    image: `ghcr.io/${repository.toLowerCase()}`,
  };
}

// Stable versions order by (major, minor, patch, revision); a base release has revision 0.
function stableKey(version) {
  const [base, revision = "0"] = version.split("-revised.");
  return [...base.split(".").map(BigInt), BigInt(revision)];
}

export function isLatestStable(tag, tags) {
  const current = releaseMetadata(tag, "owner/repo");
  if (current.prerelease) return false;
  const version = stableKey(current.version);
  for (const candidate of tags) {
    let other;
    try {
      other = releaseMetadata(candidate, "owner/repo");
    } catch {
      continue;
    }
    if (other.prerelease) continue;
    const parts = stableKey(other.version);
    for (let i = 0; i < version.length; i++) {
      if (parts[i] > version[i]) return false;
      if (parts[i] < version[i]) break;
    }
  }
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, tag, repository] = process.argv.slice(2);
  try {
    if (command === "metadata") {
      const metadata = releaseMetadata(tag, repository);
      process.stdout.write(
        Object.entries(metadata)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    } else if (command === "latest") {
      const tags = readFileSync(0, "utf8")
        .trim()
        .split("\n")
        .map((line) =>
          line
            .trim()
            .split(/\s+/)
            .at(-1)
            .replace(/^refs\/tags\//, ""),
        );
      process.stdout.write(String(isLatestStable(tag, tags)) + "\n");
    } else {
      throw new Error(
        "Usage: node scripts/release.mjs metadata TAG OWNER/REPO | latest TAG < remote-tags",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
