import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/commands/greet.js";
import { hash } from "../src/commands/hash.js";
import { time } from "../src/commands/time.js";

test("greet prints Hello, name!", () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    greet("world");
  } finally {
    console.log = orig;
  }
  assert.equal(logs[0], "Hello, world!");
});

test("greet --upper", () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    greet("world", { upper: true });
  } finally {
    console.log = orig;
  }
  assert.equal(logs[0], "HELLO, WORLD!");
});

test("hash returns 64-char hex", () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    hash("hello");
  } finally {
    console.log = orig;
  }
  assert.match(logs[0], /^[a-f0-9]{64}$/);
});

test("time unix prints number", () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    time({ format: "unix" });
  } finally {
    console.log = orig;
  }
  assert.match(String(logs[0]), /^\d+$/);
});
