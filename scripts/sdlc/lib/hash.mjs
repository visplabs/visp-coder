// The hash the owner approves: SHA-256 of the intent and acceptance blocks as parsed data with
// sorted keys, so reformatting the issue body does not change it but any change of content does.

import { createHash } from "node:crypto";

export function specHash(intent, acceptance) {
  return createHash("sha256").update(canonical({ intent, acceptance })).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
