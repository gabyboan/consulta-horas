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

async function consultaCon(resultadoRpc, opciones = {}) {
  const {
    carreraId = 1,
    registrosImprevistos = [],
  } = opciones;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("siteverify")) {
      return Response.json({ success: true, hostname: "hesm-horas.pages.dev" });
    }
    if (target.includes("/rpc/rpc_consulta_horas_public")) {
      return Response.json([resultadoRpc]);
    }
    if (target.includes("/persona_carreras?")) {
      return Response.json(carreraId == null ? [] : [{ carrera_id: carreraId }]);
    }
    if (target.includes("/imprevistos_registros?")) {
      return Response.json(registrosImprevistos);
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
    return { response, body: await response.json() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
test("calcula los imprevistos disponibles para carreras habilitadas", async () => {
  const { response, body } = await consultaCon({
    apellido: "Ejemplo",
    nombre: "Persona",
    particular_restantes_hhmm: "2:30",
    enfermedad_usada: false,
    horas_a_favor_hhmm: "5:45",
    francos_disponibles: 2,
    imprevistos_disponibles: null,
  });

  assert.equal(response.status, 200);
  assert.equal(body.horas_a_favor_hhmm, "5:45");
  assert.equal(body.francos_disponibles, 2);
  assert.equal(body.imprevistos_disponibles, 3);
});

test("no informa imprevistos para carreras no habilitadas", async () => {
  const { body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Sin beneficio",
      particular_restantes_hhmm: "0:00",
      enfermedad_usada: true,
      horas_a_favor_hhmm: "0:15",
      francos_disponibles: 1,
    },
    { carreraId: 2 },
  );

  assert.equal(body.imprevistos_disponibles, null);
});

test("descuenta los imprevistos activos del año", async () => {
  const { body } = await consultaCon(
    {
      apellido: "Ejemplo",
      nombre: "Con usos",
      particular_restantes_hhmm: "1:00",
      enfermedad_usada: false,
    },
    { carreraId: 3, registrosImprevistos: [{ id: 1 }, { id: 2 }] },
  );

  assert.equal(body.imprevistos_disponibles, 1);
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