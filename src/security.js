// Server-side helpers. No secrets or employee identifiers belong in logs.
export class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function requireSecrets(env) {
  if (typeof env.CONSULTA_ACCESS_SECRET !== "string" ||
      env.CONSULTA_ACCESS_SECRET.length < 32 ||
      typeof env.TURNSTILE_SECRET !== "string" || !env.TURNSTILE_SECRET) {
    throw new AccessError(503, "Servicio temporalmente no disponible");
  }
}

export async function fingerprint(kind, value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(kind + ":" + value));
  return kind + ":" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function limitRequest(binding, kind, value, env) {
  if (!binding || typeof binding.limit !== "function") {
    throw new AccessError(503, "Servicio temporalmente no disponible");
  }
  const result = await binding.limit({
    key: await fingerprint(kind, value, env.CONSULTA_ACCESS_SECRET),
  });
  if (result?.success !== true) {
    throw new AccessError(429, "Demasiadas consultas. Intenta nuevamente en un minuto.");
  }
}

// The optional service MUST validate identity and resolve DNI from an authoritative
// employee directory. It is a private Cloudflare service binding, never a client URL.
export async function employeeFor(request, env) {
  // Explicit public-read policy: CAPTCHA proves no employee identity.
  if (env.EMPLOYEE_AUTH_MODE === "public-captcha") return null;
  if (env.EMPLOYEE_AUTH_MODE === "supabase") {
    const authorization = request.headers.get("Authorization") || "";
    if (!/^Bearer [^\s]{1,4096}$/.test(authorization)) {
      throw new AccessError(401, "Identificacion de empleado requerida");
    }
    return supabaseEmployee(authorization, env);
  }
  if (env.EMPLOYEE_AUTH_MODE !== "service" || !env.EMPLOYEE_AUTH?.fetch) {
    throw new AccessError(503, "Identificacion de empleado no configurada");
  }
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer [^\s]{1,4096}$/.test(authorization)) {
    throw new AccessError(401, "Identificacion de empleado requerida");
  }
  const response = await env.EMPLOYEE_AUTH.fetch("https://employee-auth.internal/identity", {
    method: "POST",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AccessError(403, "Empleado no autorizado");
  }
  if (!response.ok) throw new AccessError(503, "No se pudo verificar la identidad");
  const employee = await response.json();
  if (typeof employee?.subject !== "string" || employee.subject.length < 1 ||
      employee.subject.length > 128 || !/^[0-9]{6,10}$/.test(employee?.dni || "") ||
      typeof employee.dni !== "string") {
    throw new AccessError(503, "No se pudo verificar la identidad");
  }
  return { subject: employee.subject, dni: employee.dni };
}

export async function readJson(request, maxBytes = 1024) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AccessError(415, "Se requiere JSON");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError(400, "DNI invalido");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AccessError(413, "Solicitud demasiado grande");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AccessError(400, "JSON invalido"); }
  return body;
}

export async function readDni(request) {
  const body = await readJson(request);
  if (!body || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.dni !== "string" || (!/^[0-9]{6,10}$/.test(body.dni) || Number(body.dni) > 2147483647)) {
    throw new AccessError(400, "DNI invalido");
  }
  return body.dni;
}

function supabaseConfig(env) {
  if (!/^https:\/\/[^/]+\.supabase\.co$/.test(env.SUPABASE_URL || "") ||
      !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new AccessError(503, "Servicio temporalmente no disponible");
  }
}

async function supabaseFetch(env, path, options = {}) {
  supabaseConfig(env);
  return fetch(env.SUPABASE_URL + path, {
    ...options,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...options.headers },
    signal: AbortSignal.timeout(10000), redirect: "manual", cache: "no-store",
  });
}

// Auth validates the bearer remotely on EVERY request. Never trust decoded claims
// or client-editable user_metadata to choose an employee.
async function supabaseEmployee(authorization, env) {
  const userResponse = await supabaseFetch(env, "/auth/v1/user", {
    headers: { Authorization: authorization },
  });
  if ([401, 403].includes(userResponse.status)) throw new AccessError(403, "Acceso no verificado o vencido");
  if (!userResponse.ok) throw new AccessError(503, "No se pudo verificar la identidad");
  const user = await userResponse.json();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user?.id || "") ||
      !user.email_confirmed_at || user.is_anonymous === true) {
    throw new AccessError(403, "Empleado no autorizado");
  }
  // The existing SELECT-own RLS policy is an additional check. Use the employee's
  // bearer here, never service_role authorization. Reject ambiguous mappings.
  const directory = await supabaseFetch(env,
    "/rest/v1/usuarios?select=dni&auth_user_id=eq." + encodeURIComponent(user.id) + "&limit=2", {
      headers: { Authorization: authorization, Accept: "application/json" },
    });
  if (!directory.ok) throw new AccessError(503, "No se pudo verificar la identidad");
  const rows = await directory.json();
  const dni = rows?.length === 1 ? String(rows[0].dni ?? "") : "";
  if (!Array.isArray(rows) || !/^[0-9]{6,10}$/.test(dni) || Number(dni) > 2147483647) {
    throw new AccessError(403, "Empleado no autorizado");
  }
  return { subject: user.id, dni };
}

export async function signInEmployee(request, env) {
  const body = await readJson(request, 4096);
  if (!body || Array.isArray(body) || Object.keys(body).length !== 2 ||
      typeof body.email !== "string" || body.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
      typeof body.password !== "string" || body.password.length < 1 || body.password.length > 1024) {
    throw new AccessError(400, "Credenciales invalidas");
  }
  await limitRequest(env.ACCESO_RATE_LIMITER, "login-account", body.email.trim().toLowerCase(), env);
  const response = await supabaseFetch(env, "/auth/v1/token?grant_type=password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });
  if (!response.ok) {
    if (response.status === 429) throw new AccessError(429, "Demasiados intentos. Intenta nuevamente en un minuto.");
    if (response.status >= 500) throw new AccessError(503, "No se pudo verificar la identidad");
    // Same response for nonexistent user, incorrect password and disabled accounts.
    throw new AccessError(403, "No se pudo habilitar el acceso");
  }
  const session = await response.json();
  if (typeof session.access_token !== "string" || session.access_token.length > 4096 ||
      !Number.isFinite(session.expires_in) || session.expires_in <= 0) {
    throw new AccessError(503, "No se pudo verificar la identidad");
  }
  const employee = await supabaseEmployee("Bearer " + session.access_token, env);
  // Refresh tokens and passwords are never returned or persisted by this app.
  return { employee, identityToken: session.access_token };
}
