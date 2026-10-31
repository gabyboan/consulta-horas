import { AccessError, requireSecrets, limitRequest, employeeFor, readDni, signInEmployee } from "./security.js";

const PRODUCTION_ORIGIN = "https://hesm-horas.pages.dev";
const PREVIEW_ORIGIN =
  "https://preliminar-saldos-y-imprevis.hesm-horas.pages.dev";
const ALLOWED_ORIGINS = new Set([PRODUCTION_ORIGIN, PREVIEW_ORIGIN]);

const SUPABASE_RPC = "/rest/v1/rpc/rpc_consulta_horas_public";
const BENEFICIOS_RPC = "/rest/v1/rpc/rpc_consulta_horas_beneficios_public";
const CARRERA_RPC =
  "/rest/v1/rpc/rpc_consulta_horas_carrera_preliminar";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_HOSTNAMES = new Set([
  "hesm-horas.pages.dev",
  "preliminar-saldos-y-imprevis.hesm-horas.pages.dev",
]);
const ACCESS_TOKEN_VERSION = "consulta-horas-access-v2";
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const textEncoder = new TextEncoder();

function json(body, status = 200, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    Vary: "Origin",
  };

  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  if (status === 429) headers["Retry-After"] = "60";
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function maskDni(dni) {
  return `${dni.slice(0, 2)}****${dni.slice(-2)}`;
}

function optionalHhmm(value) {
  if (typeof value !== "string") return null;

  const match = /^(\d{1,4}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const minutes = Number(match[2]);
  return minutes >= 0 && minutes <= 59 ? value.trim() : null;
}

function optionalNonNegativeInteger(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function verifyTurnstile(token, remoteIp, secret) {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(10000),
    // workerd supports manual/follow only. Non-2xx responses fail closed below.
    redirect: "manual",
  });

  if (!response.ok) return { success: false };

  return response.json();
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function accessSigningKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createAccessToken(origin, secret, subject = null) {
  const payload = base64UrlEncode(
    textEncoder.encode(
      JSON.stringify({
        origin,
        sub: subject,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await accessSigningKey(secret),
      textEncoder.encode(`${ACCESS_TOKEN_VERSION}.${payload}`),
    ),
  );

  return `${payload}.${base64UrlEncode(signature)}`;
}

async function validateAccessToken(token, origin, secret, subject = null) {
  if (typeof token !== "string" || token.length > 2048) return false;
  const [payload, signature, extra] = (token || "").split(".");
  if (!payload || !signature || extra) return false;

  const signatureBytes = base64UrlDecode(signature);
  const payloadBytes = base64UrlDecode(payload);
  if (!signatureBytes || signatureBytes.length !== 32 || !payloadBytes) return false;

  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await accessSigningKey(secret),
    signatureBytes,
    textEncoder.encode(`${ACCESS_TOKEN_VERSION}.${payload}`),
  );
  if (!validSignature) return false;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
    const valid = (
      parsed?.origin === origin &&
      parsed.sub === subject &&
      typeof parsed.jti === "string" && parsed.jti.length === 36 &&
      Number.isInteger(parsed.iat) && Number.isInteger(parsed.exp) &&
      parsed.iat <= Math.floor(Date.now() / 1000) + 30 &&
      parsed.exp > parsed.iat &&
      parsed.exp - parsed.iat <= ACCESS_TOKEN_TTL_SECONDS &&
      parsed.exp > Math.floor(Date.now() / 1000)
    );
    return valid ? parsed : null;
  } catch {
    return false;
  }
}
async function querySupabase(dni, env) {
  const response = await fetch(`${env.SUPABASE_URL}${SUPABASE_RPC}`, {
    method: "POST",
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(10000),
    redirect: "manual",

    body: JSON.stringify({ p_dni: Number(dni) }),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "supabase_rpc_error",
        status: response.status,
      }),
    );
    throw new Error("Supabase RPC failed");
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload[0] : payload;
}

async function queryCarrera(dni, env) {
  const response = await fetch(`${env.SUPABASE_URL}${CARRERA_RPC}`, {
    method: "POST",
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(10000),
    redirect: "manual",
    body: JSON.stringify({ p_dni: Number(dni) }),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "supabase_carrera_preliminar_rpc_error",
        status: response.status,
      }),
    );
    throw new Error("Supabase preview career RPC failed");
  }

  const payload = await response.json();
  const result = Array.isArray(payload) ? payload[0] : payload;
  const carreraId = Number(result?.carrera_id);

  if (![1, 2, 3].includes(carreraId)) return null;

  return {
    apellido: typeof result?.apellido === "string" ? result.apellido : "",
    nombre: typeof result?.nombre === "string" ? result.nombre : "",
    carrera_id: carreraId,
  };
}
async function queryBeneficios(dni, env) {
  const response = await fetch(`${env.SUPABASE_URL}${BENEFICIOS_RPC}`, {
    method: "POST",
    headers: supabaseHeaders(env),
    signal: AbortSignal.timeout(10000),
    redirect: "manual",
    body: JSON.stringify({ p_dni: Number(dni) }),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "supabase_beneficios_rpc_error",
        status: response.status,
      }),
    );
    throw new Error("Supabase benefits RPC failed");
  }

  const payload = await response.json();
  const result = Array.isArray(payload) ? payload[0] : payload;

  return {
    francos_disponibles_hhmm: optionalHhmm(
      result?.francos_disponibles_hhmm,
    ),
    imprevistos_disponibles: optionalNonNegativeInteger(
      result?.imprevistos_disponibles,
    ),
  };
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    if (!ALLOWED_ORIGINS.has(origin)) {
      return json({ error: "Origen no permitido" }, 403, origin);
    }
    if (!["/acceso", "/sesion", "/consulta"].includes(url.pathname)) {
      return json({ error: "No encontrado" }, 404, origin);
    }
    if (request.method === "OPTIONS") {
      const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
        .toLowerCase().split(",").map(h => h.trim()).filter(Boolean);
      const allowedHeaders = ["content-type", "authorization", "x-turnstile-token", "x-consulta-access"];
      if (request.headers.get("Access-Control-Request-Method") !== "POST" ||
          requestedHeaders.some(h => !allowedHeaders.includes(h))) {
        return json({ error: "Preflight no permitido" }, 403, origin);
      }
      const response = json(null, 204, origin);
      response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      response.headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      return response;
    }
    if (request.method !== "POST") {
      const response = json({ error: "Metodo no permitido" }, 405, origin);
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }
    if (url.search) return json({ error: "No se permiten parametros en la URL" }, 400, origin);
    try {
      requireSecrets(env);
      const remoteIp = request.headers.get("CF-Connecting-IP");
      if (!remoteIp) throw new AccessError(403, "Acceso no verificado");
      await limitRequest(
        url.pathname === "/acceso" ? env.ACCESO_RATE_LIMITER : env.CONSULTA_IP_RATE_LIMITER,
        url.pathname === "/acceso" ? "access-ip" : "query-ip", remoteIp, env,
      );
      let employee;
      if (url.pathname === "/acceso") {
        const token = request.headers.get("X-Turnstile-Token") || "";
        if (!token || token.length > 2048) throw new AccessError(403, "Captcha requerido");
        const result = await verifyTurnstile(token, remoteIp, env.TURNSTILE_SECRET);
        const challengeTime = Date.parse(result.challenge_ts);
        const age = Date.now() - challengeTime;
        if (result.success !== true || result.action !== "turnstile-spin-v1" ||
            !TURNSTILE_HOSTNAMES.has(result.hostname) ||
            result.hostname !== new URL(origin).hostname ||
            !Number.isFinite(challengeTime) || age < -30000 || age > 300000) {
          throw new AccessError(403, "Captcha invalido o vencido");
        }
        let identityToken;
        if (env.EMPLOYEE_AUTH_MODE === "supabase") {
          const signedIn = await signInEmployee(request, env);
          employee = signedIn.employee;
          identityToken = signedIn.identityToken;
        } else {
          employee = await employeeFor(request, env);
        }
        return json({
          access_token: await createAccessToken(origin, env.CONSULTA_ACCESS_SECRET, employee?.subject ?? null),
          ...(identityToken ? { identity_token: identityToken } : {}),
        }, 200, origin);
      }
      employee = await employeeFor(request, env);
      const access = await validateAccessToken(
        request.headers.get("X-Consulta-Access"), origin,
        env.CONSULTA_ACCESS_SECRET, employee?.subject ?? null,
      );
      if (!access) throw new AccessError(403, "Acceso no verificado o vencido");
      if (url.pathname === "/sesion") {
        // workerd can expose an empty stream for a POST with no body.
        const reader = request.body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.byteLength) {
                await reader.cancel();
                throw new AccessError(400, "Solicitud invalida");
              }
            }
          } finally { reader.releaseLock(); }
        }
        return json({ valid: true, expires_in: access.exp - Math.floor(Date.now() / 1000) }, 200, origin);
      }
      if (!employee) {
        await limitRequest(env.CONSULTA_TOKEN_RATE_LIMITER, "query-token",
          request.headers.get("X-Consulta-Access"), env);
      }
      const requestedDni = await readDni(request);
      if (employee && requestedDni !== employee.dni) {
        throw new AccessError(403, "Empleado no autorizado");
      }
      const dni = employee?.dni ?? requestedDni;
      // RPC bigint/integer parameters treat leading zeros as the same DNI.
      await limitRequest(env.CONSULTA_RATE_LIMITER, "employee-query", String(Number(dni)), env);
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY ||
          !/^https:\/\/[^/]+\.supabase\.co$/.test(env.SUPABASE_URL)) {
        throw new AccessError(503, "Servicio temporalmente no disponible");
      }
      let result = await querySupabase(dni, env);
      const carrera = await queryCarrera(dni, env);
      if (!carrera) {
        return json({ found: false }, 200, origin);
      }

      // La carrera 2 no tiene horas particulares ni por enfermedad, por eso
      // puede no existir en la RPC historica de horas.
      if (!result && carrera.carrera_id === 2) {
        result = {
          apellido: carrera.apellido,
          nombre: carrera.nombre,
        };
      }

      if (!result) {
        return json({ found: false }, 200, origin);
      }

      const responseBody = {
        found: true,
        dni_masked: maskDni(dni),
        apellido: typeof result.apellido === "string" ? result.apellido : "",
        nombre: typeof result.nombre === "string" ? result.nombre : "",
        mostrar_horas_regulares: carrera.carrera_id !== 2,
      };

      if (responseBody.mostrar_horas_regulares) {
        responseBody.particular_restantes_hhmm = optionalHhmm(result.particular_restantes_hhmm);
        responseBody.enfermedad_usada = Boolean(result.enfermedad_usada);
      }

      const beneficios = await queryBeneficios(dni, env);
      responseBody.francos_disponibles_hhmm = beneficios.francos_disponibles_hhmm;
      responseBody.imprevistos_disponibles = beneficios.imprevistos_disponibles;

      return json(responseBody, 200, origin);
    } catch (error) {
      // Never log request bodies, bearer tokens, DNI, upstream payloads or error messages.
      if (!(error instanceof AccessError)) console.error(JSON.stringify({ event: "request_failed" }));
      return json({ error: error instanceof AccessError ? error.message :
        "No se pudo realizar la solicitud" }, error instanceof AccessError ? error.status : 502, origin);
    }
  },
};
