import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chromium } from "playwright";
import worker from "../src/index.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8788";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("This fictional-data test only accepts a local server");
}
const origin = "https://hesm-horas.pages.dev";
const yes = { limit: async () => ({ success: true }) };
const env = {
  EMPLOYEE_AUTH_MODE: "public-captcha",
  CONSULTA_ACCESS_SECRET: "fictional-browser-test-secret-at-least-32",
  TURNSTILE_SECRET: "fictional-turnstile-secret",
  SUPABASE_URL: "https://fictional.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fictional-key",
  ACCESO_RATE_LIMITER: yes, CONSULTA_IP_RATE_LIMITER: yes,
  CONSULTA_RATE_LIMITER: yes, CONSULTA_TOKEN_RATE_LIMITER: yes,
};
const upstream = [];
let employeeName = { apellido: "Ficticio", nombre: "Prueba" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  upstream.push({ url: String(url), init });
  if (String(url).includes("siteverify")) return Response.json({
    success: true, hostname: new URL(origin).hostname,
    action: "turnstile-spin-v1", challenge_ts: new Date().toISOString(),
  });
  if (String(url).includes("carrera_preliminar")) return Response.json([{ carrera_id: 1 }]);
  if (String(url).includes("beneficios_public")) return Response.json([{
    francos_disponibles_hhmm: "1:30", imprevistos_disponibles: 2,
  }]);
  return Response.json([{
    ...employeeName, particular_restantes_hhmm: "2:00",
    enfermedad_usada: false, dni: 12345678,
  }]);
};
const browser = await chromium.launch({
  headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  let holdSession = false;
  let releaseSession;
  let sessionStatus = 200;
  let sessionTtl;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://challenges.cloudflare.com/**", route => route.fulfill({
    contentType: "text/javascript", body: "window.turnstile = {reset(){}};",
  }));
  await page.route("https://static.cloudflareinsights.com/**", route => route.fulfill({
    contentType: "text/javascript", body: "",
  }));
  await page.route("https://consulta-horas.recursoshumanos-hesm.workers.dev/**", async route => {
    const browserRequest = route.request();
    requests.push({ url: browserRequest.url(), method: browserRequest.method(), body: browserRequest.postData() });
    const isSession = new URL(browserRequest.url()).pathname === "/sesion";
    if (isSession && holdSession) await new Promise(resolve => { releaseSession = resolve; });
    const workerHeaders = new Headers(browserRequest.headers());
    workerHeaders.set("Origin", origin);
    workerHeaders.set("CF-Connecting-IP", "192.0.2.44");
    const response = await worker.fetch(new Request(browserRequest.url(), {
      method: browserRequest.method(),
      headers: workerHeaders,
      ...(browserRequest.postData() ? { body: browserRequest.postData() } : {}),
    }), env);
    const headers = Object.fromEntries(response.headers);
    // The local test origin is deliberately never added to the deployed Worker allowlist.
    headers["access-control-allow-origin"] = new URL(base).origin;
    if (isSession && sessionStatus !== 200) {
      await route.fulfill({ status: sessionStatus, headers, body: JSON.stringify({error: "Servicio temporalmente no disponible"}) });
      return;
    }
    if (isSession && sessionTtl && response.ok) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({valid:true, expires_in:sessionTtl}) });
      return;
    }
    await route.fulfill({ status: response.status, headers, body: await response.text() });
  });
  for (const path of ["/", "/consulta", "/consulta/", "/assets/gate.js", "/muestra-preliminar"]) {
    const response = await context.request.get(base + path);
    assert.equal(response.status(), 200, path);
    assert.equal(response.headers()["x-frame-options"], "DENY", path);
    assert.equal(response.headers()["cache-control"], "no-store", path);
    assert.match(response.headers()["content-security-policy"], /frame-ancestors 'none'/, path);
  }
  await page.goto(base + "/consulta");
  await page.waitForURL(base + "/");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.locator("#dni").count(), 0, "CAPTCHA must come before the DNI");
  holdSession = true;
  await page.evaluate(() => window.onTurnstileOk("fictional-captcha"));
  await page.waitForURL(base + "/consulta");
  await page.waitForFunction(() => document.getElementById("accessMessage") !== null);
  // Wait until the server check is pending; no DNI may be displayed meanwhile.
  for (let i=0; !releaseSession && i<100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(releaseSession);
  assert.equal(await page.locator("#dni").isVisible(), false);
  holdSession = false;
  releaseSession();
  await page.locator("#dni").fill("12345678");
  await page.locator("#btn").click();
  await page.locator("#out").waitFor({ state: "visible" });
  assert.equal(await page.locator("#nombre").textContent(), "Ficticio Prueba");
  assert.match(await page.locator("#dniOut").textContent(), /12\*\*\*\*78/);
  assert.match(await page.locator("#francos").textContent(), /1:30/);
  assert.match(await page.locator("#imprevistos").textContent(), /2/);
  const query = requests.find(r => r.url.endsWith("/consulta"));
  assert.equal(query.method, "POST");
  assert.deepEqual(JSON.parse(query.body), { dni: "12345678" });
  assert.equal(requests.some(r => r.url.includes("12345678")), false);
  assert.equal(upstream.length, 4);
  const sessionCheck = requests.find(r => r.url.endsWith("/sesion"));
  assert.equal(sessionCheck.method, "POST");
  assert.equal(sessionCheck.body, null);
  // Hostile database values must remain text, without executable DOM elements.
  employeeName = { apellido: '<img src=x onerror="window.xssExecuted=true">', nombre: '<svg onload="window.xssExecuted=true">' };
  await page.locator("#btn").click();
  await page.waitForFunction(() => document.getElementById("nombre").textContent.includes("<img"));
  assert.equal(await page.locator("#nombre").textContent(), `${employeeName.apellido} ${employeeName.nombre}`);
  assert.equal(await page.locator("#nombre img, #nombre svg").count(), 0);
  assert.equal(await page.evaluate(() => window.xssExecuted), undefined);
  // Browser actually enforces inline-script and framing restrictions.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.inlineExecuted = true";
    document.head.append(script);
  });
  assert.equal(await page.evaluate(() => window.inlineExecuted), undefined);
  // A failed/removed JS submit handler must not fall back to GET ?dni=... .
  const cspMessages = [];
  page.on("console", message => cspMessages.push(message.text()));
  const beforeFallback = page.url();
  await page.evaluate(() => {
    const form = document.getElementById("frm");
    const clone = form.cloneNode(true);
    form.replaceWith(clone);
    clone.querySelector("#dni").value = "12345678";
    clone.requestSubmit();
  });
  await page.waitForFunction(() => document.querySelector("#frm") !== null);
  assert.equal(page.url(), beforeFallback);
  assert.ok(cspMessages.some(message => /form-action/i.test(message)));
  // Serve a test-only parent without its own CSP, to isolate the child frame-ancestors protection.
  const frameErrors = [];
  page.on("console", message => frameErrors.push(message.text()));
  await page.route(base + "/frame-test", route => route.fulfill({
    contentType: "text/html", body: '<!doctype html><iframe src="/"></iframe>',
  }));
  await page.goto(base + "/frame-test");
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument === null);
  assert.ok(frameErrors.some(message => /frame-ancestors|X-Frame-Options/i.test(message)));
  await page.goto(base + "/consulta");
  await page.locator("#dni").fill("12345678");
  await page.evaluate(() => sessionStorage.setItem("consultaHorasAccessToken", "invalid"));
  await page.locator("#btn").click();
  await page.waitForURL(base + "/");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("consultaHorasAccessToken")), null);
  // Nonempty stale storage must return to CAPTCHA before requesting a DNI.
  const now = Math.floor(Date.now()/1000);
  const payload = Buffer.from(JSON.stringify({origin, sub:null, iat:now-700, exp:now-100, jti:"00000000-0000-4000-8000-000000000000"})).toString("base64url");
  const expired = payload + "." + createHmac("sha256", env.CONSULTA_ACCESS_SECRET).update("consulta-horas-access-v2." + payload).digest("base64url");
  const queriesBefore = requests.filter(r => r.url.endsWith("/consulta")).length;
  for (const token of ["invalid", expired]) {
    await page.evaluate(token => sessionStorage.setItem("consultaHorasAccessToken", token), token);
    await page.goto(base + "/consulta");
    await page.waitForURL(base + "/");
    assert.equal(await page.locator("#dni").count(), 0);
  }
  assert.equal(requests.filter(r => r.url.endsWith("/consulta")).length, queriesBefore);
  // A session service outage fails closed without prompting for personal data.
  sessionStatus = 503;
  await page.evaluate(() => window.onTurnstileOk("fictional-captcha-2"));
  await page.waitForURL(base + "/consulta");
  await page.waitForFunction(() => document.getElementById("accessMessage")?.textContent.includes("Servicio temporalmente"));
  assert.equal(await page.locator("#dni").isVisible(), false);
  sessionStatus = 200;
  await page.reload();
  await page.locator("#dni").waitFor({state:"visible"});
  // Restored browser history must revalidate access before exposing the form.
  await page.evaluate(() => {
    sessionStorage.setItem("consultaHorasAccessToken", "invalid");
    window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted:true}));
  });
  await page.waitForURL(base + "/");
  sessionTtl = 1;
  await page.evaluate(() => window.onTurnstileOk("fictional-captcha-3"));
  await page.waitForURL(base + "/consulta");
  await page.locator("#dni").waitFor({state:"visible"});
  await page.waitForURL(base + "/");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("consultaHorasAccessToken")), null);
  const noJs = await browser.newContext({javaScriptEnabled:false});
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(base + "/consulta");
  assert.equal(await noJsPage.locator("#dni").isVisible(), false);
  await noJs.close();
  assert.deepEqual(errors, []);
  console.log("PASS: five route headers; CAPTCHA before DNI; hidden form pending session validation and without JS; signed token -> POST query; benefits; no DNI URL; hostile HTML rendered as text; inline script and frame blocked; invalid/expired stored tokens return to gate before DNI; session outage fails closed; browser history revalidates; automatic expiry clears access.");
} finally {
  globalThis.fetch = realFetch;
  await browser.close();
}
