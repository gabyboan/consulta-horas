import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const origin = "https://hesm-horas.pages.dev";
const previewOrigin =
  "https://preliminar-saldos-y-imprevis.hesm-horas.pages.dev";

function testEnvironment() {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-key",
    TURNSTILE_SECRET: "test-turnstile-secret",
    CONSULTA_ACCESS_SECRET: "test-access-secret",
    CONSULTA_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  };
}

async function obtenerAcceso(env, allowedOrigin = origin) {
  const request = new Request("https://worker.example/acceso", {
    method: "POST",
    headers: {
      Origin: allowedOrigin,
      "X-Turnstile-Token": "test-token",
    },
  });
  const response = await worker.fetch(request, env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(typeof body.access_token, "string");
  return body.access_token;
}

async function consultaCon(resultadoRpc, opciones = {}) {
  const { allowedOrigin = origin, resultadoBeneficios = {} } = opciones;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return Response.json({
        success: true,
        hostname: new URL(allowedOrigin).hostname,
      });
    }
    if (target.includes("/rpc/rpc_consulta_horas_beneficios_public")) {
      return Response.json([resultadoBeneficios]);
    }
    if (target.includes("/rpc/rpc_consulta_horas_public")) {
      return Response.json([resultadoRpc]);
    }
    throw new Error(`Fetch inesperado: ${target}`);
  };

  try {
    const env = testEnvironment();
    const accessToken = await obtenerAcceso(env, allowedOrigin);
    const request = new Request("https://worker.example/consulta?dni=12345678", {
      headers: {
        Origin: allowedOrigin,
        "X-Consulta-Access": accessToken,
      },
    });
    const response = await worker.fetch(request, env);
    return { response, body: await response.json() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
test("devuelve francos e imprevistos informados por la RPC en la vista preliminar", async () => {
  const { response, body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Persona",
      particular_restantes_hhmm: "2:30",
      enfermedad_usada: false,
      horas_a_favor_hhmm: "5:45",
    },
    {
      allowedOrigin: previewOrigin,
      resultadoBeneficios: {
        francos_disponibles_hhmm: "2:00",
        imprevistos_disponibles: 3,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(body.horas_a_favor_hhmm, "5:45");
  assert.equal(body.francos_disponibles_hhmm, "2:00");
  assert.equal(body.imprevistos_disponibles, 3);
});

test("omite beneficios no informados por la RPC en la vista preliminar", async () => {
  const { body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Sin beneficio",
      particular_restantes_hhmm: "0:00",
      enfermedad_usada: true,
      horas_a_favor_hhmm: "0:15",
    },
    { allowedOrigin: previewOrigin },
  );

  assert.equal(body.francos_disponibles_hhmm, null);
  assert.equal(body.imprevistos_disponibles, null);
});

test("conserva el saldo de imprevistos recibido por la RPC preliminar", async () => {
  const { body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Con usos",
      particular_restantes_hhmm: "1:00",
      enfermedad_usada: false,
    },
    {
      allowedOrigin: previewOrigin,
      resultadoBeneficios: { imprevistos_disponibles: 1 },
    },
  );

  assert.equal(body.imprevistos_disponibles, 1);
});
test("requiere un pase de acceso tambien desde la vista preliminar", async () => {
  const request = new Request(
    "https://consulta-horas.recursoshumanos-hesm.workers.dev/consulta?dni=12345678",
    {
      headers: {
        Origin: previewOrigin,
        "X-Turnstile-Token": "test-token",
      },
    },
  );
  const response = await worker.fetch(request, testEnvironment());

  assert.equal(response.status, 403);
});

test("mantiene la respuesta publicada sin consultar beneficios preliminares", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return Response.json({ success: true, hostname: "hesm-horas.pages.dev" });
    }
    if (target.includes("/rpc/rpc_consulta_horas_public")) {
      return Response.json([
        {
          apellido: "Ejemplo",
          nombre: "Publicado",
          particular_restantes_hhmm: "1:30",
          enfermedad_usada: false,
          francos_disponibles: 2,
          imprevistos_disponibles: 1,
        },
      ]);
    }
    throw new Error(`Fetch inesperado: ${target}`);
  };

  try {
    const request = new Request("https://worker.example/consulta?dni=12345678", {
      headers: {
        Origin: origin,
        "X-Turnstile-Token": "test-token",
      },
    });
    const response = await worker.fetch(request, testEnvironment());
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.francos_disponibles, 2);
    assert.equal(body.imprevistos_disponibles, 1);
    assert.equal("francos_disponibles_hhmm" in body, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("emite un pase solo luego de verificar Turnstile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("siteverify")) {
      return Response.json({ success: true, hostname: "hesm-horas.pages.dev" });
    }
    throw new Error(`Fetch inesperado: ${url}`);
  };

  try {
    const env = testEnvironment();
    const accessToken = await obtenerAcceso(env);
    assert.match(accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("acepta un pase valido emitido para la vista preliminar", async () => {
  const { response, body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Preview",
      particular_restantes_hhmm: "1:00",
      enfermedad_usada: false,
    },
    { allowedOrigin: previewOrigin },
  );

  assert.equal(response.status, 200);
  assert.equal(body.found, true);
});

test("rechaza un pase emitido para otro origen", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("siteverify")) {
      return Response.json({ success: true, hostname: "hesm-horas.pages.dev" });
    }
    throw new Error(`Fetch inesperado: ${url}`);
  };

  try {
    const env = testEnvironment();
    const accessToken = await obtenerAcceso(env, origin);
    const request = new Request("https://worker.example/consulta?dni=12345678", {
      headers: {
        Origin: previewOrigin,
        "X-Consulta-Access": accessToken,
      },
    });
    const response = await worker.fetch(request, env);

    assert.equal(response.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("permite el preflight de los dos encabezados de seguridad", async () => {
  const request = new Request("https://worker.example/acceso", {
    method: "OPTIONS",
    headers: { Origin: origin },
  });
  const response = await worker.fetch(request, testEnvironment());

  assert.equal(response.status, 204);
  assert.match(
    response.headers.get("Access-Control-Allow-Headers") || "",
    /X-Consulta-Access/,
  );
});