// Guard: the shipped agentcli SKILL.md must stay in sync with the actual protocol.
// If you change exit codes, flags, or command surface, update skills/agentcli/SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SKILL = path.join(ROOT, "skills", "agentcli", "SKILL.md");

test("skill file exists with valid frontmatter", () => {
  const raw = fs.readFileSync(SKILL, "utf8");
  assert.match(raw, /^---\n/);
  const end = raw.indexOf("\n---", 4);
  assert.ok(end > 0, "frontmatter must be closed");
  const front = raw.slice(4, end);
  assert.match(front, /^name: agentcli$/m);
  assert.match(front, /^description: .+/m);
});

test("skill teaches the core loop commands", () => {
  const raw = fs.readFileSync(SKILL, "utf8");
  assert.match(raw, /agentcli server list/);
  assert.match(raw, /<server> -h|--help/);
  assert.match(raw, /<tool> -h|--help/);
});

test("skill documents the escape hatch and flags", () => {
  const raw = fs.readFileSync(SKILL, "utf8");
  assert.match(raw, /--input/);
  assert.match(raw, /--output/);
  assert.match(raw, /--refresh/);
});

test("skill documents all implemented exit codes", () => {
  const raw = fs.readFileSync(SKILL, "utf8");
  for (const code of [0, 1, 2, 10, 12, 13]) {
    assert.match(raw, new RegExp("\\b" + code + "\\b.*\\|"), "exit code " + code + " missing from skill");
  }
});

test("skill stays thin: no tool catalogs", () => {
  const raw = fs.readFileSync(SKILL, "utf8");
  // The skill must teach a method, not enumerate tools from any specific server.
  assert.ok(raw.length < 6000, "skill is drifting toward a tool catalog; keep it under 6KB, currently " + raw.length);
});