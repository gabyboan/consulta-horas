import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("workerd: CAPTCHA y tres RPC funcionan sin seguir redirecciones ni exponer secretos", async () => {
  const origin = "https://hesm-horas.pages.dev";
  const calls = [];
  let redirectPath = "";
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "runtime-test",
    modules: await Promise.all(["index.js", "security.js"].map(async name => ({
      type: "ESModule", path: name,
      contents: await readFile(new URL("../src/" + name, import.meta.url), "utf8"),
    }))),
    compatibilityDate: "2026-06-03", compatibilityFlags: ["nodejs_compat"],
    bindings: {
      EMPLOYEE_AUTH_MODE: "public-captcha",
      CONSULTA_ACCESS_SECRET: "fictional-runtime-secret-at-least-32-characters",
      TURNSTILE_SECRET: "fictional-secret", SUPABASE_URL: "https://fictional.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fictional-service-key",
    },
    ratelimits: Object.fromEntries(["ACCESO_RATE_LIMITER", "CONSULTA_IP_RATE_LIMITER", "CONSULTA_TOKEN_RATE_LIMITER", "CONSULTA_RATE_LIMITER"].map((name, i) => [name, {
      namespace_id: String(i + 1), simple: { limit: 100, period: 60 },
    }])),
    outboundService: async request => {
      const path = new URL(request.url).pathname;
      calls.push({ path });
      if (path === redirectPath) return new Response(null, { status: 302, headers: { Location: "https://never-contact.invalid/" } });
      if (path.endsWith("siteverify")) return Response.json({
        success: true, action: "turnstile-spin-v1", hostname: new URL(origin).hostname, challenge_ts: new Date().toISOString(),
      });
      if (path.endsWith("carrera_preliminar")) return Response.json([{ carrera_id: 1 }]);
      if (path.endsWith("beneficios_public")) return Response.json([{ francos_disponibles_hhmm: "1:30", imprevistos_disponibles: 2 }]);
      assert.deepEqual(await request.json(), { p_dni: 12345678 });
      return Response.json([{ apellido: "Ficticio", nombre: "Prueba", particular_restantes_hhmm: "2:00", enfermedad_usada: false }]);
    },
  }] }));
  const headers = { Origin: origin, "CF-Connecting-IP": "192.0.2.8" };
  try {
    const access = await mf.dispatchFetch("https://worker.test/acceso", { method: "POST", headers: { ...headers, "X-Turnstile-Token": "fictional-captcha" } });
    assert.equal(access.status, 200, JSON.stringify({ body: await access.clone().text(), calls }));
    const { access_token } = await access.json();
    const session = await mf.dispatchFetch("https://worker.test/sesion", { method: "POST", headers: { ...headers, "X-Consulta-Access": access_token } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).valid, true);
    assert.equal(calls.length, 1, "session validation must not read employee data");
    const invalidSession = await mf.dispatchFetch("https://worker.test/sesion", { method: "POST", headers: { ...headers, "X-Consulta-Access": "invalid" } });
    assert.equal(invalidSession.status, 403);
    const bodySession = await mf.dispatchFetch("https://worker.test/sesion", { method: "POST", headers: { ...headers, "X-Consulta-Access": access_token }, body: "unexpected" });
    assert.equal(bodySession.status, 400);
    const query = () => mf.dispatchFetch("https://worker.test/consulta", { method: "POST", headers: { ...headers, "X-Consulta-Access": access_token, "Content-Type": "application/json" }, body: JSON.stringify({ dni: "12345678" }) });
    const result = await query();
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).nombre, "Prueba");
    assert.equal(calls.length, 4);
    redirectPath = "/turnstile/v0/siteverify";
    const rejected = await mf.dispatchFetch("https://worker.test/acceso", { method: "POST", headers: { ...headers, "X-Turnstile-Token": "fictional-captcha-2" } });
    assert.equal(rejected.status, 403);
    assert.equal("access_token" in await rejected.json(), false);
    redirectPath = "/rest/v1/rpc/rpc_consulta_horas_public";
    assert.equal((await query()).status, 502);
    assert.equal(calls.some(call => call.path === "/"), false);
  } finally { await mf.dispose(); }
});
