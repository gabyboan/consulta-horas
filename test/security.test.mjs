import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import worker from "../src/index.js";

const origin = "https://hesm-horas.pages.dev";
const secret = "fictional-secret-only-for-testing-32-plus";
const yes = () => ({ limit: async () => ({ success: true }) });
const environment = () => ({
  CONSULTA_ACCESS_SECRET: secret, TURNSTILE_SECRET: "fake-server-secret",
  EMPLOYEE_AUTH_MODE: "service",
  EMPLOYEE_AUTH: { fetch: async () => Response.json({ subject: "fictional-user", dni: "12345678" }) },
  SUPABASE_URL: "https://fictional.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake-key",
  ACCESO_RATE_LIMITER: yes(), CONSULTA_IP_RATE_LIMITER: yes(), CONSULTA_RATE_LIMITER: yes(),
});
function request(path, options = {}) {
  const { headers, ...rest } = options;
  return new Request("https://local.example" + path, {
    method: "POST", ...rest,
    headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.10", Authorization: "Bearer fictitious", ...headers },
  });
}
function signed(overrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    origin, sub: "fictional-user", iat, exp: iat + 600, jti: "00000000-0000-4000-8000-000000000000", ...overrides,
  })).toString("base64url");
  return payload + "." + createHmac("sha256", secret)
    .update("consulta-horas-access-v2." + payload).digest("base64url");
}
function query(token = signed(), body = { dni: "12345678" }, headers = {}) {
  return request("/consulta", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Consulta-Access": token, ...headers },
  });
}
function check(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
}
async function fixture(run, verification = {}) {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("siteverify")) return Response.json({
      success: true, hostname: new URL(origin).hostname,
      action: "turnstile-spin-v1", challenge_ts: new Date().toISOString(), ...verification,
    });
    if (String(url).includes("carrera_preliminar")) return Response.json([{ carrera_id: 1 }]);
    if (String(url).includes("beneficios_public")) return Response.json([{ francos_disponibles_hhmm: "1:30", imprevistos_disponibles: 2 }]);
    return Response.json([{ apellido: "Ficticio", nombre: "Prueba", particular_restantes_hhmm: "2:00", enfermedad_usada: false, dni: 12345678, secreto: "not-returned" }]);
  };
  try { await run(environment(), calls); } finally { globalThis.fetch = old; }
}

test("sesion valida firma y caducidad antes de mostrar DNI sin consultar datos personales", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "public-captcha";
    const session = token => request("/sesion", { headers: { "X-Consulta-Access": token } });
    for (const token of ["", "invalid", signed({ sub: null, exp: Math.floor(Date.now()/1000)-1 }), signed()]) {
      check(await worker.fetch(session(token), env), 403);
    }
    // A session check must not spend the token/DNI query budget or read Supabase.
    env.CONSULTA_TOKEN_RATE_LIMITER = { limit: () => { throw new Error("query budget used"); } };
    env.CONSULTA_RATE_LIMITER = env.CONSULTA_TOKEN_RATE_LIMITER;
    const response = await worker.fetch(session(signed({ sub: null })), env);
    check(response, 200);
    const data = await response.json();
    assert.deepEqual(Object.keys(data).sort(), ["expires_in", "valid"]);
    assert.equal(data.valid, true);
    assert.ok(data.expires_in > 0 && data.expires_in <= 600);
    assert.equal(calls.length, 0);
  });
});

test("sesion rechaza cuerpos, URL con parametros, origen ajeno y metodos no permitidos", async () => {
  await fixture(async (env, calls) => {
    const headers = { "X-Consulta-Access": signed() };
    check(await worker.fetch(request("/sesion", { headers, body: '{"dni":"12345678"}' }), env), 400);
    check(await worker.fetch(request("/sesion?dni=12345678", { headers }), env), 400);
    check(await worker.fetch(request("/sesion", { headers, method: "GET" }), env), 405);
    check(await worker.fetch(request("/sesion", { headers: { ...headers, Origin: "https://attacker.example" } }), env), 403);
    env.CONSULTA_IP_RATE_LIMITER = { limit: async () => ({ success: false }) };
    check(await worker.fetch(request("/sesion", { headers }), env), 429);
    delete env.CONSULTA_IP_RATE_LIMITER;
    check(await worker.fetch(request("/sesion", { headers }), env), 503);
    assert.equal(calls.length, 0);
  });
});
test("rechaza token ausente, alterado, vencido, futuro, otra firma, formato, TTL excesivo y otro origen", async () => {
  await fixture(async (env, calls) => {
    const now = Math.floor(Date.now() / 1000);
    for (const token of ["", "bad", signed().slice(0, -10), signed({ exp: now - 1 }),
      signed({ iat: now + 120, exp: now + 600 }), signed({ exp: now + 601 }),
      signed({ origin: "https://elsewhere.example" }), signed({ sub: "wrong-user" }),
      signed({ exp: "tomorrow" }), "a".repeat(2049)]) {
      check(await worker.fetch(query(token), env), 403);
    }
    assert.equal(calls.length, 0);
  });
});
test("flujo CAPTCHA -> token firmado -> consulta POST: conserva beneficios y minimiza respuesta", async () => {
  await fixture(async (env, calls) => {
    const access = await worker.fetch(request("/acceso", { headers: { "X-Turnstile-Token": "fake-captcha" } }), env);
    check(access, 200);
    const { access_token } = await access.json();
    const result = await worker.fetch(query(access_token), env);
    check(result, 200);
    const data = await result.json();
    assert.equal(data.found, true);
    assert.equal(data.imprevistos_disponibles, 2);
    assert.equal(data.particular_restantes_hhmm, "2:00");
    assert.equal("dni" in data, false);
    assert.equal("secreto" in data, false);
    for (const { url, init } of calls.slice(1)) {
      assert.equal(url.includes("12345678"), false);
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), { p_dni: 12345678 });
    }
    assert.equal(calls[0].init.body.get("secret"), env.TURNSTILE_SECRET);
    assert.equal(calls[0].init.body.get("remoteip"), "192.0.2.10");
  });
});
for (const [name, invalid] of Object.entries({
  invalid: { success: false }, reused: { success: false, "error-codes": ["timeout-or-duplicate"] },
  hostname: { hostname: "attacker.example" },
  allowed_but_other_hostname: { hostname: "preliminar-saldos-y-imprevis.hesm-horas.pages.dev" },
  action: { action: "different" }, expired: { challenge_ts: "2000-01-01T00:00:00Z" },
  missing_timestamp: { challenge_ts: null }, future: { challenge_ts: "2100-01-01T00:00:00Z" },
})) test("CAPTCHA rechaza " + name + " segun Siteverify simulado", async () => {
  await fixture(async (env, calls) => {
    const result = await worker.fetch(request("/acceso", { headers: { "X-Turnstile-Token": "fake" } }), env);
    check(result, 403);
    assert.equal(calls.length, 1);
    assert.equal("access_token" in await result.json(), false);
  }, invalid);
});
test("CAPTCHA ausente o demasiado largo no llama Siteverify", async () => {
  await fixture(async (env, calls) => {
    check(await worker.fetch(request("/acceso"), env), 403);
    check(await worker.fetch(request("/acceso", { headers: { "X-Turnstile-Token": "a".repeat(2049) } }), env), 403);
    assert.equal(calls.length, 0);
  });
});
test("consulta rechaza entradas malformadas, tipos, propiedades extra, inyeccion y cuerpo grande", async () => {
  await fixture(async (env, calls) => {
    for (const body of [null, [], {}, { dni: 12345678 }, { dni: "12345678x" }, { dni: "12345" },
      { dni: "12345678901" }, { dni: "12345678", extra: 1 }, { dni: "' OR 1=1 --" }]) {
      check(await worker.fetch(query(signed(), body), env), 400);
    }
    check(await worker.fetch(request("/consulta", { headers: { "X-Consulta-Access": signed(), "Content-Type": "application/json" }, body: "{" }), env), 400);
    check(await worker.fetch(request("/consulta", { headers: { "X-Consulta-Access": signed() }, body: "12345678" }), env), 415);
    check(await worker.fetch(query(signed(), { dni: "1".repeat(1100) }), env), 413);
    assert.equal(calls.length, 0);
  });
});
test("limites por IP y empleado rechazan y nunca consultan origen; claves HMAC no contienen DNI/IP", async () => {
  await fixture(async (env, calls) => {
    for (const binding of ["ACCESO_RATE_LIMITER", "CONSULTA_IP_RATE_LIMITER", "CONSULTA_RATE_LIMITER"]) {
      const current = environment();
      current[binding] = { limit: async ({ key }) => {
        assert.match(key, /^[a-z-]+:[a-f0-9]{64}$/);
        assert.equal(key.includes("192.0.2.10"), false);
        assert.equal(key.includes("12345678"), false);
        return { success: false };
      } };
      const result = await worker.fetch(binding === "ACCESO_RATE_LIMITER" ? request("/acceso") : query(), current);
      check(result, 429);
      assert.equal(result.headers.get("Retry-After"), "60");
      delete current[binding];
      check(await worker.fetch(binding === "ACCESO_RATE_LIMITER" ? request("/acceso") : query(), current), 503);
    }
    assert.equal(calls.length, 0);
  });
});
test("configuracion ausente o secreto corto falla cerrado", async () => {
  await fixture(async (env, calls) => {
    for (const patch of [{ CONSULTA_ACCESS_SECRET: "short" }, { TURNSTILE_SECRET: "" },
      { EMPLOYEE_AUTH_MODE: undefined }, { EMPLOYEE_AUTH_MODE: "service", EMPLOYEE_AUTH: undefined }, { SUPABASE_URL: "http://unsafe.example" }]) {
      check(await worker.fetch(query(), { ...env, ...patch }), 503);
    }
    assert.equal(calls.length, 0);
  });
});
test("modo identidad exige credencial y rechaza otro empleado o servicio fallido antes de RPC", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "service";
    env.EMPLOYEE_AUTH = { fetch: async () => Response.json({ subject: "fictional-user", dni: "12345678" }) };
    check(await worker.fetch(query(signed(), { dni: "12345678" }, { Authorization: "" }), env), 401);
    check(await worker.fetch(query(signed({ sub: "fictional-user" }), { dni: "87654321" }, { Authorization: "Bearer fictitious" }), env), 403);
    check(await worker.fetch(query(signed({ sub: "other-user" }), { dni: "12345678" }, { Authorization: "Bearer fictitious" }), env), 403);
    env.EMPLOYEE_AUTH.fetch = async () => new Response(null, { status: 403 });
    check(await worker.fetch(query(signed(), { dni: "12345678" }, { Authorization: "Bearer fictitious" }), env), 403);
    env.EMPLOYEE_AUTH.fetch = async () => new Response(null, { status: 503 });
    check(await worker.fetch(query(signed(), { dni: "12345678" }, { Authorization: "Bearer fictitious" }), env), 503);
    assert.equal(calls.length, 0);
  });
});
test("flujo valido con identidad privada vincula el token al sujeto y consulta solo el DNI del servidor", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "service";
    env.EMPLOYEE_AUTH = { fetch: async (_url, init) => {
      assert.equal(init.headers.Authorization, "Bearer fictitious");
      return Response.json({ subject: "fictional-user", dni: "12345678" });
    } };
    const access = await worker.fetch(request("/acceso", { headers: {
      Authorization: "Bearer fictitious", "X-Turnstile-Token": "fake",
    } }), env);
    check(access, 200);
    const { access_token } = await access.json();
    const claims = JSON.parse(Buffer.from(access_token.split(".")[0], "base64url"));
    assert.equal(claims.sub, "fictional-user");
    assert.equal("dni" in claims, false);
    check(await worker.fetch(query(access_token, { dni: "12345678" }, { Authorization: "Bearer fictitious" }), env), 200);
    assert.equal(calls.length, 4);
  });
});
test("modo desconocido falla cerrado", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "legacy-captcha";
    check(await worker.fetch(query(signed(), { dni: "87654321" }), env), 503);
    assert.equal(calls.length, 0);
  });
});
test("politica publica: CAPTCHA habilita distintos DNI ficticios sin cuenta; riesgo de identidad explicito", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "public-captcha";
    env.CONSULTA_TOKEN_RATE_LIMITER = yes();
    env.EMPLOYEE_AUTH = { fetch: async () => { throw new Error("Public reads must not use RRHH identity"); } };
    const access = await worker.fetch(request("/acceso", { headers: { Authorization: "", "X-Turnstile-Token": "fake" } }), env);
    check(access, 200);
    const { access_token } = await access.json();
    const claims = JSON.parse(Buffer.from(access_token.split(".")[0], "base64url"));
    assert.equal(claims.sub, null);
    check(await worker.fetch(query(access_token, { dni: "12345678" }, { Authorization: "" }), env), 200);
    check(await worker.fetch(query(access_token, { dni: "87654321" }, { Authorization: "" }), env), 200);
    assert.equal(calls.length, 7);
    assert.deepEqual(JSON.parse(calls[6].init.body), { p_dni: 87654321 });
    env.CONSULTA_TOKEN_RATE_LIMITER = { limit: async () => ({ success: false }) };
    check(await worker.fetch(query(access_token), env), 429);
    delete env.CONSULTA_TOKEN_RATE_LIMITER;
    check(await worker.fetch(query(access_token), env), 503);
    check(await worker.fetch(query("bad"), env), 403);
    assert.equal(calls.length, 7);
  });
});
test("el limite por DNI agrupa variantes con ceros iniciales como la RPC numerica", async () => {
  await fixture(async (env, calls) => {
    env.EMPLOYEE_AUTH_MODE = "public-captcha";
    env.CONSULTA_TOKEN_RATE_LIMITER = yes();
    const keys = [];
    env.CONSULTA_RATE_LIMITER = { limit: async ({key}) => { keys.push(key); return { success: true }; } };
    for (const dni of ["12345678", "012345678"]) {
      check(await worker.fetch(query(signed({ sub: null }), { dni }), env), 200);
    }
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(calls.length, 6);
    assert.deepEqual(JSON.parse(calls[5].init.body), { p_dni: 12345678 });
  });
});
test("CORS cerrado, metodos limitados, GET retirado y URL sin parametros", async () => {
  const env = environment();
  check(await worker.fetch(query(signed(), { dni: "12345678" }, { Origin: "https://attacker.example" }), env), 403);
  check(await worker.fetch(request("/consulta?dni=12345678", { method: "GET" }), env), 405);
  check(await worker.fetch(request("/consulta?dni=12345678"), env), 400);
  check(await worker.fetch(request("/missing"), env), 404);
  const preflight = (method, headers) => request("/consulta", { method: "OPTIONS", headers: {
    "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers,
  } });
  check(await worker.fetch(preflight("GET", "content-type"), env), 403);
  check(await worker.fetch(preflight("POST", "x-unsafe"), env), 403);
  const allowed = await worker.fetch(preflight("POST", "content-type,x-consulta-access,authorization"), env);
  check(allowed, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(allowed.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});
test("fallos de red no emiten acceso ni datos ni errores internos", async () => {
  const original = globalThis.fetch;
  const logs = [];
  const oldError = console.error;
  console.error = (...values) => logs.push(values.join(" "));
  globalThis.fetch = async () => { throw new Error("fake-secret 12345678 bearer-private"); };
  try {
    const access = await worker.fetch(request("/acceso", { headers: { "X-Turnstile-Token": "fake" } }), environment());
    check(access, 502);
    const result = await worker.fetch(query(), environment());
    check(result, 502);
    assert.equal(JSON.stringify(logs).includes("fake-secret"), false);
    assert.equal(JSON.stringify(logs).includes("12345678"), false);
    assert.equal((await result.text()).includes("bearer-private"), false);
  } finally { globalThis.fetch = original; console.error = oldError; }
});
