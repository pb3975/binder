// Checks that package.json and CHANGELOG.md agree, and prints release notes.
//   bun scripts/release-check.ts               every PR: the changelog parses and lists package.json's version
//   bun scripts/release-check.ts --tag v1.2.3  on a tag: the tag, package.json, and a dated changelog entry match
//   bun scripts/release-check.ts --notes 1.2.3 prints that version's changelog section
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm)].map((m) => ({
  name: m[1]!,
  date: m[2] ?? null,
  at: m.index!,
}));

function section(name: string): string | null {
  const i = headings.findIndex((h) => h.name === name);
  if (i < 0) return null;
  const start = changelog.indexOf("\n", headings[i]!.at) + 1;
  const end = headings[i + 1]?.at ?? changelog.search(/^\[[^\]]+\]: /m);
  return changelog.slice(start, end < 0 ? undefined : end).trim();
}

const fail = (msg: string): never => {
  console.error(`release-check: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args[0] === "--notes") {
  const notes = section(args[1] ?? version) ?? fail(`no CHANGELOG.md section for ${args[1] ?? version}`);
  console.log(notes);
  process.exit(0);
}

if (!SEMVER.test(version)) fail(`package.json version "${version}" is not semver`);
if (headings[0]?.name !== "Unreleased") fail("CHANGELOG.md must start with an [Unreleased] section");
for (const h of headings.slice(1)) {
  if (!SEMVER.test(h.name)) fail(`CHANGELOG.md heading [${h.name}] is not a version`);
  if (!h.date) fail(`CHANGELOG.md heading [${h.name}] needs a release date (## [x.y.z] - YYYY-MM-DD)`);
}
const entry = headings.find((h) => h.name === version) ?? fail(`CHANGELOG.md has no [${version}] section for package.json's version`);

if (args[0] === "--tag") {
  const tag = args[1] ?? fail("--tag needs a value such as v1.2.3");
  if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version}`);
  if (headings[1]?.name !== version) fail(`[${version}] must be the newest released section in CHANGELOG.md`);
  if (!section(version)) fail(`CHANGELOG.md section [${version}] is empty`);
}

console.log(`release-check: ${version} (${entry.date}) ok`);
