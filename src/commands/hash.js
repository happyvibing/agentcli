import { createHash } from "node:crypto";

export function hash(text) {
  const digest = createHash("sha256").update(text).digest("hex");
  console.log(digest);
}
