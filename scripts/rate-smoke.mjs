import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Only fictional local requests. Run against the documented local Wrangler command.
const base = process.env.TEST_WORKER_URL || "http://127.0.0.1:8787";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("This rate test only accepts a local Worker");
}
const origin = "https://hesm-horas.pages.dev";
const iat = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({
  origin, sub: null, iat, exp: iat + 600, jti: "00000000-0000-4000-8000-000000000000",
})).toString("base64url");
const token = payload + "." + createHmac("sha256", "fictional-local-rate-test-secret-32-plus")
  .update("consulta-horas-access-v2." + payload).digest("base64url");
const access = [];
for (let i = 0; i < 11; i++) {
  const response = await fetch(base + "/acceso", { method: "POST", headers: { Origin: origin } });
  access.push(response.status);
}
assert.deepEqual(access, [...Array(10).fill(403), 429]);
const query = [];
for (let i = 0; i < 6; i++) {
  const response = await fetch(base + "/consulta", {
    method: "POST",
    headers: { Origin: origin, "X-Consulta-Access": token, "Content-Type": "application/json" },
    body: JSON.stringify({ dni: "invalid-fictional-input" }),
  });
  query.push(response.status);
}
assert.deepEqual(query, [...Array(5).fill(400), 429]);
console.log(JSON.stringify({ result: "PASS native local rate-limit bindings", access, query }));
