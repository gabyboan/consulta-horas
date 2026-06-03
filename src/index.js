const ALLOWED_ORIGINS = new Set([
  "https://hesm-horas.pages.dev",
]);

const SUPABASE_RPC = "/rest/v1/rpc/rpc_consulta_horas_public";
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

async function verifyTurnstile(token, remoteIp, secret) {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: form,
  });

  if (!response.ok) return false;

  const result = await response.json();
  return result.success === true;
}

async function querySupabase(dni, env) {
  const response = await fetch(`${env.SUPABASE_URL}${SUPABASE_RPC}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
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

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) {
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

    if (!ALLOWED_ORIGINS.has(origin)) {
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
      const isHuman = await verifyTurnstile(
        turnstileToken,
        remoteIp,
        env.TURNSTILE_SECRET,
      );

      if (!isHuman) {
        return json({ error: "Captcha inválido o vencido" }, 403, origin);
      }

      const result = await querySupabase(dni, env);
      if (!result) {
        return json({ found: false }, 200, origin);
      }

      return json(
        {
          found: true,
          dni_masked: maskDni(dni),
          apellido: result.apellido,
          nombre: result.nombre,
          particular_restantes_hhmm: result.particular_restantes_hhmm,
          enfermedad_usada: Boolean(result.enfermedad_usada),
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
