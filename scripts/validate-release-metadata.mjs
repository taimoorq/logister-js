#!/usr/bin/env node
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const client = readFileSync(new URL("src/client.ts", root), "utf8");
const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");
const version = packageJson.version;

if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
  fail(`package-lock.json does not match package version ${version}`);
}
if (!client.includes(`logister-js/${version}`)) {
  fail(`default SDK user agent does not match package version ${version}`);
}
if (!changelog.split("\n").some((line) => line === `## v${version}` || line.startsWith(`## v${version} `))) {
  fail(`CHANGELOG.md is missing a v${version} heading`);
}

process.stdout.write(`release metadata ok v${version}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, root), "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
