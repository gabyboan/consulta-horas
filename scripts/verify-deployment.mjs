import assert from "node:assert/strict";

const site = "https://hesm-horas.pages.dev";
const api = "https://consulta-horas.recursoshumanos-hesm.workers.dev";
const results = [];
for (const path of ["/", "/consulta", "/consulta/", "/index.html", "/muestra-preliminar", "/assets/gate.js", "/assets/app.js"]) {
  const response = await fetch(site + path, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  const csp = response.headers.get("Content-Security-Policy") || "";
  assert.equal(response.status, 200, path);
  assert.match(csp, /frame-ancestors 'none'/, path);
  assert.match(csp, /form-action 'none'/, path);
  assert.match(csp, /script-src-attr 'none'/, path);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY", path);
  assert.equal(response.headers.get("Cache-Control"), "no-store", path);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer", path);
  assert.match(response.headers.get("Strict-Transport-Security") || "", /max-age=31536000/, path);
  results.push({ path, status: response.status, finalUrl: response.url, csp: true, xfo: "DENY", cache: "no-store" });
  const source = await response.text();
  if (path === "/") {
    assert.equal(source.includes('type="password"'), false);
    assert.equal(source.includes('http-equiv="Content-Security-Policy"'), false);
    results.push({ analyticsScripts: [...source.matchAll(/<script[^>]*src=["'](https:\/\/static\.cloudflareinsights\.com\/[^"']+)/g)].map(match => match[1]) });
  }
  if (path === "/assets/app.js") {
    assert.equal(source.includes('method: "POST"'), true);
    assert.equal(source.includes('?dni='), false);
    assert.ok(source.includes('/sesion'));
  }
  if (path === "/consulta") assert.match(source, /id="consultaPanel" hidden/);
}
for (const [path, method, headers, expected] of [
  ["/consulta", "OPTIONS", { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-consulta-access" }, 204],
  ["/consulta", "GET", { Origin: site }, 405],
  ["/sesion", "OPTIONS", { Origin: site, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-consulta-access" }, 204],
  ["/sesion", "POST", { Origin: site }, 403],
]) {
  // No DNI, token or personal data; four bounded post-deploy protocol checks.
  const response = await fetch(api + path, { method, headers, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  const verified = response.status === expected &&
    response.headers.get("Cache-Control") === "no-store" &&
    response.headers.get("X-Frame-Options") === "DENY";
  results.push({
    apiPath: path, apiMethod: method, status: response.status, expected, verified,
    ...(verified ? {} : { limitation: /1010/.test(text) ? "Cloudflare 1010: no evidence about Worker validation" : "External Worker behavior unverified" }),
  });
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
