import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.js";

const origin = "https://hesm-horas.pages.dev";
const subject = "00000000-0000-4000-8000-000000000001";
const otherSubject = "00000000-0000-4000-8000-000000000002";
function env() {
  const limit = { limit: async () => ({ success: true }) };
  return { SUPABASE_URL: "https://fictional.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
    TURNSTILE_SECRET: "fake-secret", CONSULTA_ACCESS_SECRET: "fake-HMAC-secret-at-least-32-characters",
    EMPLOYEE_AUTH_MODE: "supabase", ACCESO_RATE_LIMITER: limit, CONSULTA_IP_RATE_LIMITER: limit, CONSULTA_RATE_LIMITER: limit };
}
function request(path, body, headers = {}) {
  return new Request("https://test.example" + path, { method: "POST",
    headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.5", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body) });
}
const loginRequest = () => request("/acceso", { email: "ficticio@example.invalid", password: "fake-password" }, { "X-Turnstile-Token": "fake-captcha" });
async function fixture(run, options = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let currentSubject = subject;
  globalThis.fetch = async (url, init) => {
    const target = String(url); calls.push({ target, init });
    assert.equal(init.redirect, "manual");
    if (target.includes("siteverify")) return Response.json({
      success: options.captcha ?? true, hostname: new URL(origin).hostname,
      action: "turnstile-spin-v1", challenge_ts: new Date().toISOString() });
    assert.equal(init.headers.apikey, "fake-service-key");
    if (target.includes("/auth/v1/token?grant_type=password")) {
      if (options.loginStatus) return Response.json({ secret: "upstream-detail" }, { status: options.loginStatus });
      assert.deepEqual(JSON.parse(init.body), { email: "ficticio@example.invalid", password: "fake-password" });
      return Response.json({ access_token: "fake-identity", refresh_token: "never-return-this", expires_in: 3600 });
    }
    if (target.endsWith("/auth/v1/user")) {
      assert.equal(init.headers.Authorization, "Bearer fake-identity");
      if (options.userStatus) return new Response(null, { status: options.userStatus });
      return Response.json({ id: currentSubject, email_confirmed_at: options.unconfirmed ? null : "2020-01-01T00:00:00Z",
        is_anonymous: options.anonymous ?? false, user_metadata: { dni: "87654321" } });
    }
    if (target.includes("/rest/v1/usuarios?")) {
      assert.equal(init.headers.Authorization, "Bearer fake-identity"); // RLS, not service role bearer
      assert.equal(target.includes("select=dni&auth_user_id=eq." + currentSubject + "&limit=2"), true);
      if (options.directoryStatus) return new Response(null, { status: options.directoryStatus });
      return Response.json(options.rows ?? [{ dni: 12345678 }]);
    }
    assert.equal(init.headers.Authorization, "Bearer fake-service-key"); // Only fixed RPCs
    if (target.includes("carrera_preliminar")) return Response.json([{ carrera_id: 1 }]);
    if (target.includes("beneficios_public")) return Response.json([{ imprevistos_disponibles: 1 }]);
    return Response.json([{ apellido: "Ficticio", nombre: "Empleado", particular_restantes_hhmm: "1:00", enfermedad_usada: false }]);
  };
  try { await run(env(), calls, value => { currentSubject = value; }); } finally { globalThis.fetch = original; }
}
test("Supabase: flujo completo usa cuenta real verificada por servidor y DNI desde RLS; nunca devuelve refresh token", async () => {
  await fixture(async (environment, calls) => {
    const access = await worker.fetch(loginRequest(), environment);
    assert.equal(access.status, 200);
    assert.equal(access.headers.get("Cache-Control"), "no-store");
    const tokens = await access.json();
    assert.deepEqual(Object.keys(tokens).sort(), ["access_token", "identity_token"]);
    assert.equal(tokens.identity_token, "fake-identity");
    assert.equal(JSON.stringify(tokens).includes("never-return-this"), false);
    const headers = { Authorization: "Bearer " + tokens.identity_token, "X-Consulta-Access": tokens.access_token };
    const response = await worker.fetch(request("/consulta", { dni: "12345678" }, headers), environment);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).found, true);
    assert.equal(calls.filter(c => c.target.endsWith("/auth/v1/user")).length, 2);
    const rpcCalls = calls.filter(c => c.target.includes("/rpc/"));
    assert.equal(rpcCalls.length, 3);
    assert.equal(rpcCalls.every(c => JSON.parse(c.init.body).p_dni === 12345678), true);
  });
});
test("Supabase: otro DNI y otro sujeto autenticado no pueden usar el pase", async () => {
  await fixture(async (environment, calls, changeSubject) => {
    const access = await worker.fetch(loginRequest(), environment);
    const tokens = await access.json();
    const headers = { Authorization: "Bearer fake-identity", "X-Consulta-Access": tokens.access_token };
    assert.equal((await worker.fetch(request("/consulta", { dni: "87654321" }, headers), environment)).status, 403);
    changeSubject(otherSubject);
    assert.equal((await worker.fetch(request("/consulta", { dni: "12345678" }, headers), environment)).status, 403);
    assert.equal(calls.some(c => c.target.includes("/rpc/")), false);
  });
});
for (const [name, options, status] of [
  ["sin vínculo", { rows: [] }, 403],
  ["vínculo ambiguo", { rows: [{ dni: 12345678 }, { dni: 87654321 }] }, 403],
  ["DNI inválido", { rows: [{ dni: null }] }, 403],
  ["email sin confirmar", { unconfirmed: true }, 403],
  ["cuenta anónima", { anonymous: true }, 403],
  ["contraseña incorrecta", { loginStatus: 400 }, 403],
  ["login limitado", { loginStatus: 429 }, 429],
  ["Auth indisponible", { loginStatus: 503 }, 503],
  ["bearer inválido o vencido", { userStatus: 401 }, 403],
  ["directorio indisponible", { directoryStatus: 503 }, 503],
]) test("Supabase: rechaza " + name, async () => {
  await fixture(async (environment, calls) => {
    const response = await worker.fetch(loginRequest(), environment);
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes("upstream-detail"), false);
    assert.equal(calls.some(c => c.target.includes("/rpc/")), false);
  }, options);
});
test("Supabase: CAPTCHA inválido detiene el flujo antes de enviar credenciales a Auth", async () => {
  await fixture(async (environment, calls) => {
    assert.equal((await worker.fetch(loginRequest(), environment)).status, 403);
    assert.equal(calls.length, 1);
  }, { captcha: false });
});
test("Supabase: consulta sin bearer o formato con espacios falla cerrado", async () => {
  await fixture(async (environment, calls) => {
    for (const authorization of ["", "Bearer one two", "Basic fake"]) {
      assert.equal((await worker.fetch(request("/consulta", { dni: "12345678" }, { Authorization: authorization }), environment)).status, 401);
    }
    assert.equal(calls.length, 0);
  });
});
test("Supabase: credenciales malformadas no se envían a Auth", async () => {
  await fixture(async (environment, calls) => {
    for (const credentials of [null, {}, { email: "x", password: "y" }, { email: "x@y.invalid", password: "" },
      { email: "x@y.invalid", password: 123 }, { email: "x@y.invalid", password: "x", extra: 1 }]) {
      assert.equal((await worker.fetch(request("/acceso", credentials, { "X-Turnstile-Token": "fake" }), environment)).status, 400);
    }
    assert.equal(calls.some(c => c.target.includes("/auth/")), false);
  });
});
