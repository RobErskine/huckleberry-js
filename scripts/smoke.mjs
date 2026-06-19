/**
 * Smoke test — the critical de-risk step (Milestone 1).
 *
 * Proves end-to-end that:
 *   1. email/password auth works, and
 *   2. a Firestore REST read with the resulting ID token succeeds (NOT 403).
 *
 * This is the single biggest risk in the whole project: the Python client used
 * gRPC and claimed plain REST returned 403. If this script prints your child
 * list, the REST approach (and therefore the Cloudflare Worker) is viable.
 *
 * Usage:
 *   npm run build
 *   HUCKLEBERRY_EMAIL=you@example.com HUCKLEBERRY_PASSWORD=secret npm run smoke
 */

import { HuckleberryClient } from "../dist/index.js";

const email = process.env.HUCKLEBERRY_EMAIL;
const password = process.env.HUCKLEBERRY_PASSWORD;

if (!email || !password) {
  console.error("Set HUCKLEBERRY_EMAIL and HUCKLEBERRY_PASSWORD env vars.");
  process.exit(1);
}

const client = new HuckleberryClient();

console.log("1/3 Authenticating…");
const session = await client.authenticate(email, password);
console.log(`    OK — uid=${session.uid}`);

console.log("2/3 Reading users/{uid} via Firestore REST…");
const user = await client.getUser();
if (!user) {
  console.error("    User document not found (unexpected).");
  process.exit(1);
}
const children = user.childList ?? [];
console.log(`    OK — ${children.length} child(ren):`);
for (const c of children) {
  console.log(`      - ${c.nickname ?? "(no nickname)"}  cid=${c.cid}`);
}

if (children.length) {
  const cid = children[0].cid;
  console.log(`3/3 Reading dashboard summary for ${cid}…`);
  const summary = await client.getDashboardSummary(
    cid,
    children[0].nickname ?? null,
  );
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("3/3 Skipped (no children on account).");
}

console.log("\n✅ REST approach works — Cloudflare Worker is viable.");
