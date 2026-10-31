# Desarrollo y verificación

[Volver al README](../README.md)

## Requisitos

- Node.js 22 o superior y npm.
- Chromium de Playwright o Microsoft Edge para las pruebas de navegador.
- Wrangler se instala como dependencia del proyecto; los comandos usan la versión fijada en `package-lock.json`.

```sh
npm ci
npm test
npm run check
npm audit --audit-level=low
```

`npm test` ejecuta las pruebas de Node y del runtime nativo workerd mediante Miniflare. Siteverify, Auth y las RPC utilizan respuestas ficticias; no se consulta información real.

`npm run check` prepara el bundle del Worker sin publicarlo. Compilar no demuestra por sí solo que los controles de seguridad funcionen.

## Frontend y pruebas de navegador

Iniciar Pages en una terminal:

```sh
npx wrangler pages dev public --port 8788
```

En otra terminal, instalar Chromium y ejecutar:

```sh
npx playwright install chromium
npm run test:browser
```

En Windows se puede usar Edge instalado, sin descargar Chromium:

```powershell
$env:BROWSER_CHANNEL = "msedge"
npm run test:browser
```

El script intercepta Turnstile y la API en el navegador, ejecuta el Worker con servicios ficticios y comprueba el flujo CAPTCHA → DNI → resultado, caducidad, historial, caché, CSP y renderizado de entradas adversas. Solo acepta una dirección local; `TEST_BASE_URL` permite cambiar el puerto.

Abrir el frontend local a mano no configura una integración de CAPTCHA de staging: sus assets siguen referenciando la API publicada. Para un flujo manual completo hay que preparar un entorno separado y actualizar sus orígenes, sitekey y endpoint. No enviar DNI reales desde el entorno de desarrollo.

## Worker local y límites nativos

Iniciar un Worker nuevo con secretos ficticios:

```sh
npx wrangler dev --local --port 8787 --var CONSULTA_ACCESS_SECRET:fictional-local-rate-test-secret-32-plus --var TURNSTILE_SECRET:fake-secret
```

En otra terminal:

```sh
node scripts/rate-smoke.mjs
```

Reiniciar el Worker entre ejecuciones para limpiar los contadores. El script solo admite un destino local y no realiza consultas a empleados reales.

## Archivos de entorno

`.dev.vars.example` contiene nombres y valores de ejemplo. Si hace falta `.dev.vars`, copiarlo y completar únicamente credenciales del entorno de prueba. `.dev.vars`, sus variantes y `.env*` están excluidos de Git, con excepción de los ejemplos.

Los valores de producción se administran como secretos del Worker; ver [despliegue](DEPLOYMENT.md). No incluir DNI, tokens, capturas con datos personales ni logs del entorno real en commits, issues o pull requests.

## Compatibilidad de Workers

Las peticiones salientes del Worker usan `redirect: "manual"` y comprueban `response.ok`. workerd no acepta `redirect: "error"`, aunque los navegadores sí. La prueba nativa conserva esta regresión y comprueba que no se sigan redirecciones de los servicios externos.
