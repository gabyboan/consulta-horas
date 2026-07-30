const PRODUCTION_ORIGIN = "https://hesm-horas.pages.dev";
const PREVIEW_ORIGIN =
  "https://preliminar-saldos-y-imprevis.hesm-horas.pages.dev";
const ALLOWED_ORIGINS = new Set([PRODUCTION_ORIGIN, PREVIEW_ORIGIN]);

const SUPABASE_RPC = "/rest/v1/rpc/rpc_consulta_horas_public";
const IMPREVISTOS_CARRERA_IDS = new Set([1, 3]);
const IMPREVISTOS_MAXIMO_ANUAL = 3;
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_HOSTNAMES = new Set([
  "hesm-horas.pages.dev",
  "preliminar-saldos-y-imprevis.hesm-horas.pages.dev",
]);

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

async function querySupabaseRows(path, env) {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: "GET",
    headers: supabaseHeaders(env),
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: "supabase_table_error",
        status: response.status,
      }),
    );
    throw new Error("Supabase table query failed");
  }

  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function currentYearInArgentina() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
    }).format(new Date()),
  );
}

async function queryImprevistosDisponibles(dni, env) {
  const carrerasParams = new URLSearchParams({
    dni: `eq.${dni}`,
    carrera_id: "in.(1,3)",
    select: "carrera_id",
  });
  const carreras = await querySupabaseRows(
    `/rest/v1/persona_carreras?${carrerasParams}`,
    env,
  );
  const carreraId = carreras
    .map((carrera) => Number(carrera?.carrera_id))
    .find((id) => IMPREVISTOS_CARRERA_IDS.has(id));

  if (!carreraId) return null;

  const registrosParams = new URLSearchParams({
    dni: `eq.${dni}`,
    carrera_id: `eq.${carreraId}`,
    anio: `eq.${currentYearInArgentina()}`,
    deleted_at: "is.null",
    select: "id",
    limit: String(IMPREVISTOS_MAXIMO_ANUAL),
  });
  const registros = await querySupabaseRows(
    `/rest/v1/imprevistos_registros?${registrosParams}`,
    env,
  );

  return Math.max(0, IMPREVISTOS_MAXIMO_ANUAL - registros.length);
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
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "X-Turnstile-Token",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    if (request.method !== "GET" || url.pathname !== "/consulta") {
      return json({ error: "No encontrado" }, 404, origin);
    }

    if (!originAllowed) {
      return json({ error: "Origen no permitido" }, 403, origin);
    }

    const dni = (url.searchParams.get("dni") || "").replace(/\D/g, "");
    if (!/^\d{6,10}$/.test(dni)) {
      return json({ error: "DNI inválido" }, 400, origin);
    }

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
        return json({ error: "Captcha inválido o vencido" }, 403, origin);
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
          { error: "Demasiadas consultas. Intentá nuevamente en un minuto." },
          429,
          origin,
        );
      }

      const result = await querySupabase(dni, env);
      if (!result) {
        return json({ found: false }, 200, origin);
      }

      const imprevistosDisponibles = await queryImprevistosDisponibles(
        Number(dni),
        env,
      );

      return json(
        {
          found: true,
          dni_masked: maskDni(dni),
          apellido: result.apellido,
          nombre: result.nombre,
          particular_restantes_hhmm: result.particular_restantes_hhmm,
          enfermedad_usada: Boolean(result.enfermedad_usada),
          horas_a_favor_hhmm: optionalHhmm(result.horas_a_favor_hhmm),
          francos_disponibles: optionalNonNegativeInteger(
            result.francos_disponibles,
          ),
          // null significa que la persona no posee este beneficio. El
          // frontend usa esa distinción para no mostrar la tarjeta.
          imprevistos_disponibles: imprevistosDisponibles,
        },
        200,
        origin,
      );
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
