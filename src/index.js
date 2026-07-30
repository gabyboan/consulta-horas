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
const ACCESS_TOKEN_VERSION = "consulta-horas-access-v1";
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const textEncoder = new TextEncoder();

function json(body, status = 200, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };

  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return new Response(JSON.stringify(body), { status, headers });
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

async function createAccessToken(origin, secret) {
  const payload = base64UrlEncode(
    textEncoder.encode(
      JSON.stringify({
        origin,
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

async function hasValidAccessToken(token, origin, secret) {
  const [payload, signature, extra] = (token || "").split(".");
  if (!payload || !signature || extra) return false;

  const signatureBytes = base64UrlDecode(signature);
  const payloadBytes = base64UrlDecode(payload);
  if (!signatureBytes || !payloadBytes) return false;

  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await accessSigningKey(secret),
    signatureBytes,
    textEncoder.encode(`${ACCESS_TOKEN_VERSION}.${payload}`),
  );
  if (!validSignature) return false;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
    return (
      parsed?.origin === origin &&
      Number.isFinite(parsed?.exp) &&
      parsed.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}
async function querySupabase(dni, env) {
  const response = await fetch(`${env.SUPABASE_URL}${SUPABASE_RPC}`, {
    method: "POST",
    headers: supabaseHeaders(env),

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
    const originAllowed = ALLOWED_ORIGINS.has(origin);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return json({ error: "Origen no permitido" }, 403, origin);
      }

      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "X-Turnstile-Token, X-Consulta-Access",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    if (!originAllowed) {
      return json({ error: "Origen no permitido" }, 403, origin);
    }

    if (request.method === "POST" && url.pathname === "/acceso") {
      const turnstileToken = request.headers.get("X-Turnstile-Token") || "";
      if (!turnstileToken) {
        return json({ error: "Captcha requerido" }, 403, origin);
      }

      try {
        const remoteIp = request.headers.get("CF-Connecting-IP") || "";
        const turnstileResult = await verifyTurnstile(
          turnstileToken,
          remoteIp,
          env.TURNSTILE_SECRET,
        );

        if (
          turnstileResult.success !== true ||
          !TURNSTILE_HOSTNAMES.has(turnstileResult.hostname)
        ) {
          console.warn(
            JSON.stringify({
              event: "turnstile_rejected",
              hostname: turnstileResult.hostname || null,
            }),
          );
          return json({ error: "Captcha invalido o vencido" }, 403, origin);
        }

        if (!env.CONSULTA_ACCESS_SECRET) {
          console.error(JSON.stringify({ event: "access_secret_missing" }));
          return json({ error: "No se pudo habilitar el acceso" }, 502, origin);
        }

        return json(
          {
            access_token: await createAccessToken(
              origin,
              env.CONSULTA_ACCESS_SECRET,
            ),
          },
          200,
          origin,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "access_error",
            message: error instanceof Error ? error.message : "unknown",
          }),
        );
        return json({ error: "No se pudo habilitar el acceso" }, 502, origin);
      }
    }

    if (request.method !== "GET" || url.pathname !== "/consulta") {
      return json({ error: "No encontrado" }, 404, origin);
    }

    const dni = (url.searchParams.get("dni") || "").replace(/\D/g, "");
    if (!/^\d{6,10}$/.test(dni)) {
      return json({ error: "DNI invalido" }, 400, origin);
    }

    try {
      if (!env.CONSULTA_ACCESS_SECRET) {
        console.error(JSON.stringify({ event: "access_secret_missing" }));
        return json({ error: "No se pudo habilitar el acceso" }, 502, origin);
      }

      const accessToken = request.headers.get("X-Consulta-Access") || "";
      let hasAccess = await hasValidAccessToken(
        accessToken,
        origin,
        env.CONSULTA_ACCESS_SECRET,
      );


      if (!hasAccess) {
        return json({ error: "Acceso no verificado o vencido" }, 403, origin);
      }

      const rateLimit = await env.CONSULTA_RATE_LIMITER.limit({ key: dni });
      if (!rateLimit.success) {
        console.warn(
          JSON.stringify({
            event: "consulta_rate_limited",
            dni_masked: maskDni(dni),
          }),
        );
        return json(
          { error: "Demasiadas consultas. Intenta nuevamente en un minuto." },
          429,
          origin,
        );
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
        apellido: result.apellido,
        nombre: result.nombre,
        mostrar_horas_regulares: carrera.carrera_id !== 2,
      };

      if (responseBody.mostrar_horas_regulares) {
        responseBody.particular_restantes_hhmm = result.particular_restantes_hhmm;
        responseBody.enfermedad_usada = Boolean(result.enfermedad_usada);
      }

      const beneficios = await queryBeneficios(dni, env);
      responseBody.francos_disponibles_hhmm = beneficios.francos_disponibles_hhmm;
      responseBody.imprevistos_disponibles = beneficios.imprevistos_disponibles;

      return json(responseBody, 200, origin);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "consulta_error",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      return json({ error: "No se pudo realizar la consulta" }, 502, origin);
    }
  },
};