/**
 * Prepares a release: sets the version, dates the changelog section, runs the full gate,
 * commits, and tags. Pushing stays a separate step unless `--push` is passed, because it is
 * the point where the release becomes public and the tag starts the publish workflow.
 *
 *   pnpm release 0.1.1
 *   pnpm release 0.1.1 --push
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packagePath = join(packageRoot, "package.json");
const changelogPath = join(packageRoot, "CHANGELOG.md");
/** Every package is released together, so all manifests carry the same version. */
const WORKSPACE_PACKAGES = ["core", "d2", "display", "plugin"];
const manifestPaths = [
  packagePath,
  ...WORKSPACE_PACKAGES.map((name) => join(packageRoot, "packages", name, "package.json")),
];
const UNRELEASED_HEADING = "## [Unreleased]";
const RELEASE_BRANCH = "main";
const VERSION_LINE = /^(\s*"version":\s*")([^"]*)(")/m;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();
}

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) {
    fail(`${label} is not a three-part version: ${JSON.stringify(value)}.`);
  }
  return match.slice(1, 4).map(Number);
}

function isAfter(candidate, current) {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== current[index]) {
      return candidate[index] > current[index];
    }
  }
  return false;
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The entries under `## [Unreleased]`, up to the previous release's heading. */
function unreleasedSection(changelog) {
  const start = changelog.indexOf(UNRELEASED_HEADING);
  if (start === -1) {
    fail(`CHANGELOG.md has no ${UNRELEASED_HEADING} section.`);
  }
  const rest = changelog.slice(start + UNRELEASED_HEADING.length);
  const nextHeading = rest.search(/^## /mu);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

const args = process.argv.slice(2);
const push = args.includes("--push");
const requested = args.find((argument) => !argument.startsWith("-"));
if (!requested || args.some((a) => a.startsWith("-") && a !== "--push")) {
  fail("usage: pnpm release <version> [--push]");
}

const manifests = manifestPaths.map((path) => readFileSync(path, "utf8"));
const currentVersion = VERSION_LINE.exec(manifests[0])?.[2];
if (!currentVersion) {
  fail("package.json has no version field.");
}
for (const [index, manifest] of manifests.entries()) {
  const version = VERSION_LINE.exec(manifest)?.[2];
  if (version !== currentVersion) {
    fail(`${manifestPaths[index]} is at ${version}, not ${currentVersion}.`);
  }
}
if (
  !isAfter(
    parseVersion(requested, "the requested version"),
    parseVersion(currentVersion, "the current version"),
  )
) {
  fail(`${requested} is not above the current version ${currentVersion}.`);
}

const tag = `v${requested}`;
if (git("status", "--porcelain")) {
  fail("the working tree has uncommitted changes. Commit or stash them first.");
}
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== RELEASE_BRANCH) {
  fail(`releases run from ${RELEASE_BRANCH}, but ${branch} is checked out.`);
}
if (git("tag", "--list", tag)) {
  fail(`${tag} already exists.`);
}

const changelog = readFileSync(changelogPath, "utf8");
if (!/^\s*-\s+\S/mu.test(unreleasedSection(changelog))) {
  fail(`${UNRELEASED_HEADING} has no entries, so there is nothing to release.`);
}

for (const [index, manifest] of manifests.entries()) {
  writeFileSync(manifestPaths[index], manifest.replace(VERSION_LINE, `$1${requested}$3`));
}
writeFileSync(
  changelogPath,
  changelog.replace(UNRELEASED_HEADING, `## [${requested}] - ${today()}`),
);
console.log(`release: prepared ${requested}, running the full gate.`);

try {
  execFileSync("pnpm", ["check"], { cwd: packageRoot, stdio: "inherit" });
} catch {
  git("checkout", "--", ...manifestPaths, changelogPath);
  fail("pnpm check failed. The manifests and CHANGELOG.md were restored.");
}

git("add", ...manifestPaths, changelogPath);
git("commit", "-m", `chore: release ${requested}`);
git("tag", tag);

if (!push) {
  console.log(`release: committed and tagged ${tag}. Publish it with:`);
  console.log(`\n  git push && git push origin ${tag}\n`);
  console.log(`Undo it with:\n\n  git tag -d ${tag} && git reset --hard HEAD~1\n`);
  process.exit(0);
}

execFileSync("git", ["push"], { cwd: packageRoot, stdio: "inherit" });
execFileSync("git", ["push", "origin", tag], { cwd: packageRoot, stdio: "inherit" });
console.log(`release: pushed ${tag}. The release workflow publishes from here.`);
