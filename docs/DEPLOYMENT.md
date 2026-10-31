# Despliegue y operación

[Volver al README](../README.md)

## Componentes

| Componente | Destino |
| --- | --- |
| Frontend | Pages: `hesm-horas`, rama de producción `main`. |
| Portal | <https://hesm-horas.pages.dev/> |
| API | Worker: `consulta-horas`. |
| Endpoint | <https://consulta-horas.recursoshumanos-hesm.workers.dev> |
| Datos | RPC existentes del proyecto Supabase autorizado; no hay migraciones en esta revisión. |

`wrangler.jsonc` configura el Worker. Pages recibe explícitamente el directorio `public`; no se comparten sus bindings con el frontend.

## Secretos y configuración

Configurar únicamente en el servidor:

```sh
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put CONSULTA_ACCESS_SECRET
```

- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: proyecto institucional confirmado por el responsable. La clave de servicio nunca debe aparecer en HTML, JavaScript del navegador o Git.
- `TURNSTILE_SECRET`: secreto del widget cuya sitekey pública está instalada en el frontend. Action esperada: `turnstile-spin-v1`.
- `CONSULTA_ACCESS_SECRET`: al menos 32 caracteres generados criptográficamente. Rotarlo invalida todos los pases existentes. Los pases duran 10 minutos y no son credenciales de identidad.

El modo activo es `EMPLOYEE_AUTH_MODE=public-captcha`. Los adaptadores de identidad opcionales `supabase` y `service` están desactivados y requieren completar los [requisitos de identidad](../SECURITY_REVIEW.md#identidad-del-empleado) antes de usarlos.

Orígenes y hostnames admitidos: `hesm-horas.pages.dev` y `preliminar-saldos-y-imprevis.hesm-horas.pages.dev`. Un dominio nuevo requiere revisar Worker, CSP, frontend y widget Turnstile. Las vistas previas arbitrarias no se autorizan automáticamente.

## Publicar mediante Wrangler

```sh
npm ci
npm test
npm audit --audit-level=low
npm run check
npx wrangler whoami
npm run deploy:worker
npm run deploy:pages
```

Ejecutar sobre un checkout limpio de `main` y comprobar que Wrangler usa la cuenta institucional configurada. Publicar Worker y Pages coordinadamente: el cliente usa POST `/sesion` y POST `/consulta`; el antiguo GET con DNI ya no se admite. Los clientes antiguos deben recargar y completar nuevamente el CAPTCHA.

## Publicar desde GitHub Actions

El workflow **Deploy to Cloudflare** se inicia manualmente en [Actions](https://github.com/gabyboan/consulta-horas/actions/workflows/deploy.yml), mediante **Run workflow** sobre `main`. Antes ejecuta pruebas, auditoría y dry-run.

En **Settings → Secrets and variables → Actions**, configurar:

| Tipo | Nombre | Uso |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Token dedicado con permisos de edición de Workers y Pages, limitado a la cuenta institucional. |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Identificador de la cuenta configurada en `wrangler.jsonc`. |

La sesión OAuth local de Wrangler no configura el token de GitHub. El workflow rechaza la publicación si falta el token o la cuenta no coincide; no copiar secretos del Worker al repositorio ni usar un token de alcance global.

Subir cambios a `main` ejecuta **Security checks**, sin publicar producción. El despliegue manual queda separado para poder revisar los cambios antes de publicarlos. No hay dos despliegues concurrentes de este workflow.

## Comprobación posterior

```sh
node scripts/verify-deployment.mjs
```

Comprueba siete rutas públicas, cabeceras, caché y cuatro respuestas de protocolo de la API. No consulta DNI ni acredita por sí solo el flujo válido con datos personales. Un 403 del perímetro de Cloudflare no demuestra que el Worker haya validado un token.

El flujo completo se verifica localmente con datos ficticios. No ejecutar enumeración de DNI ni pruebas de carga en producción.

## Límites y mantenimiento

| Control | Límite por 60 segundos |
| --- | --- |
| Emisión del pase | 10 por IP |
| Consulta y comprobación de sesión | 20 por IP |
| Consulta por pase | 5 |
| Consulta por DNI normalizado | 5 |

Los bindings nativos de Cloudflare son aproximados por ubicación. Las claves se derivan con HMAC; no contienen DNI, IP o token en claro. Revisar el impacto de las IP compartidas del hospital. Un cupo global estricto requeriría estado coordinado.

Mantener revisión de Dependabot y del resultado semanal de Actions. La auditoría de npm detecta vulnerabilidades conocidas reportadas en sus fuentes; no cubre todo el código ni la configuración de las cuentas.

Para administración de Cloudflare, usar 2FA y guardar los códigos de recuperación fuera del repositorio. Revisar los permisos de tokens y la retención de logs históricos; el cambio de código no borra registros antiguos.

## WAF y dominios

El despliegue actual utiliza `pages.dev` y `workers.dev`, sin dominio propio. No se configuraron reglas WAF de zona para esos hostnames. Turnstile y los límites del Worker son los controles disponibles implementados en esta revisión.

Si se incorpora un dominio institucional, vincular frontend y API, actualizar las listas de origen/hostname y la CSP, probar reglas WAF compatibles con el plan en staging y cerrar la ruta alternativa `workers.dev` cuando corresponda, para evitar un acceso que saltee las reglas del dominio.

Referencias: [cabeceras de Pages](https://developers.cloudflare.com/pages/configuration/headers/), [secretos de Workers](https://developers.cloudflare.com/workers/configuration/secrets/), [workflow manual](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
