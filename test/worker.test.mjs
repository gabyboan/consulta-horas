import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const origin = "https://hesm-horas.pages.dev";
const previewOrigin =
  "https://preliminar-saldos-y-imprevis.hesm-horas.pages.dev";
const previewWorker =
  "https://preliminar-consulta-horas.recursoshumanos-hesm.workers.dev";

function testEnvironment() {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-key",
    TURNSTILE_SECRET: "test-secret",
    CONSULTA_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  };
}

async function consultaCon(resultadoRpc) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("siteverify")) {
      return Response.json({ success: true, hostname: "hesm-horas.pages.dev" });
    }

    return Response.json([resultadoRpc]);
  };

  try {
    const request = new Request("https://worker.example/consulta?dni=12345678", {
      headers: {
        Origin: origin,
        "X-Turnstile-Token": "test-token",
      },
    });
    const response = await worker.fetch(request, testEnvironment());
    return { response, body: await response.json() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("incluye los saldos nuevos v?lidos y conserva cero imprevistos", async () => {
  const { response, body } = await consultaCon({
    apellido: "Ejemplo",
    nombre: "Persona",
    particular_restantes_hhmm: "2:30",
    enfermedad_usada: false,
    horas_a_favor_hhmm: "5:45",
    francos_disponibles: 2,
    imprevistos_disponibles: 0,
  });

  assert.equal(response.status, 200);
  assert.equal(body.horas_a_favor_hhmm, "5:45");
  assert.equal(body.francos_disponibles, 2);
  assert.equal(body.imprevistos_disponibles, 0);
});

test("representa el beneficio no aplicable con null", async () => {
  const { body } = await consultaCon({
    apellido: "Ejemplo",
    nombre: "Sin beneficio",
    particular_restantes_hhmm: "0:00",
    enfermedad_usada: true,
    horas_a_favor_hhmm: "0:15",
    francos_disponibles: 1,
    imprevistos_disponibles: null,
  });

  assert.equal(body.imprevistos_disponibles, null);
});

test("requiere captcha también desde la vista preliminar", async () => {
  const request = new Request(
    "https://consulta-horas.recursoshumanos-hesm.workers.dev/consulta?dni=12345678",
    { headers: { Origin: previewOrigin } },
  );
  const response = await worker.fetch(request, testEnvironment());

  assert.equal(response.status, 403);
});

test("acepta un captcha válido emitido para la vista preliminar", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("siteverify")) {
      return Response.json({ success: true, hostname: new URL(previewOrigin).hostname });
    }

    return Response.json([
      {
        apellido: "Ejemplo",
        nombre: "Preview",
        particular_restantes_hhmm: "1:00",
        enfermedad_usada: false,
      },
    ]);
  };

  try {
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
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.found, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mantiene el captcha obligatorio en la API publicada", async () => {
  const request = new Request(
    "https://consulta-horas.recursoshumanos-hesm.workers.dev/consulta?dni=12345678",
    { headers: { Origin: origin } },
  );
  const response = await worker.fetch(request, testEnvironment());

  assert.equal(response.status, 403);
});