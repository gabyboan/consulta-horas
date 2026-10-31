# Revisión de seguridad

**Fecha:** 31 de octubre de 2026. **Alcance:** frontend de Pages, Worker, configuración de Cloudflare y acceso a las RPC utilizadas por este portal.

[Volver al README](README.md) · [Configuración de despliegue](docs/DEPLOYMENT.md)

## Decisión de acceso

Se conserva la consulta pública mediante DNI y CAPTCHA solicitada por el responsable. Las cuentas de Recursos Humanos pertenecen a la gestión administrativa; este portal no modifica registros ni exige esas cuentas para consultar.

**Riesgo prioritario abierto:** superar el CAPTCHA permite consultar un DNI ajeno. Los resultados incluyen nombre, saldos y estado de uso de licencia por enfermedad, según la funcionalidad existente. El enmascarado del DNI, CORS, CAPTCHA y los límites no acreditan la identidad ni resuelven esa exposición.

## Hallazgos confirmados

| Evidencia revisada | Resultado y corrección |
| --- | --- |
| Respuestas originales de `/` y `/consulta` | Sin CSP HTTP ni X-Frame-Options. `frame-ancestors` estaba en meta y no protegía el encuadre. Se añadió `public/_headers` con regla `/*`, CSP HTTP y `X-Frame-Options: DENY`. |
| Código original de cliente y Worker | DNI en GET `/consulta?dni=…`. Ahora se utiliza POST con JSON y se rechazan parámetros de URL. No se consultaron DNI reales para comprobarlo. |
| Pase posterior al CAPTCHA | Permitía elegir cualquier DNI sin identidad del empleado. El comportamiento público se conserva por la decisión funcional anterior. |
| Siteverify original | Ya comprobaba `success` y hostname permitido. Se añadió action, fecha y coincidencia exacta de hostname con el origen. |
| Pase original | Ya tenía HMAC y caducidad; no se demostró falsificación. Se endurecieron formato, fechas, duración, origen y configuración del secreto. |
| Flujo del frontend con pase guardado | Mostraba DNI antes de validar el pase; podía pedir DNI → CAPTCHA → DNI. POST `/sesion` valida antes de mostrar el formulario, sin DNI ni acceso a Supabase. |
| Peticiones externas en workerd | `redirect: "error"` provocaba fallo antes del envío. Una regresión nativa reprodujo el error; se usa `manual`, se rechazan 3xx y no se sigue `Location`. |
| RPC de Supabase utilizadas | Parámetros tipados, sin SQL dinámico; `SECURITY DEFINER` con `search_path` vacío y ejecución restringida en los metadatos revisados. No se confirmó inyección SQL. No se modificó la base compartida. |

El HTTP 403/Cloudflare 1010 observado en la revisión externa no demuestra controles dentro del Worker y no se utiliza como evidencia de autorización.

## Controles implementados

- **Navegador:** CSP HTTP con `frame-ancestors 'none'`, `form-action 'none'`, scripts y estilos sin inline/eval; excepciones concretas para Turnstile y la analítica existente. XFO DENY, nosniff, HSTS, no-referrer y permisos restringidos.
- **CAPTCHA:** Siteverify en servidor, validación de hostname/action/fecha, fallo cerrado y token Turnstile de un solo uso. No se reutiliza el CAPTCHA como pase del portal.
- **Pase:** HMAC v2, origen, fechas, identificador y caducidad máxima de 10 minutos; validación en cada sesión y consulta. Secreto únicamente en el Worker.
- **Consulta:** JSON limitado en bytes, DNI estricto y rango compatible con la RPC; peticiones parametrizadas, respuestas mínimas y `no-store`. Métodos y orígenes explícitos.
- **Abuso:** límites nativos por IP, pase y DNI normalizado, claves HMAC y rechazo ante error o ausencia de binding.
- **Privacidad:** DNI fuera de la URL, eventos de error sin contenido personal, logs de invocación desactivados y redacción de query strings. Esto no elimina logs históricos ni controla todos los servicios externos.
- **Interfaz:** contenido renderizado como texto; formulario oculto mientras se valida, ante fallo de sesión o sin JavaScript; nueva comprobación al restaurar el historial y regreso al CAPTCHA al caducar.
- **Mantenimiento:** dependencias fijadas, Actions con permisos de lectura y acciones fijadas por SHA, revisión semanal y Dependabot sin merges automáticos.

## Archivos principales

| Archivos | Responsabilidad |
| --- | --- |
| `public/_headers` | Cabeceras de todas las rutas estáticas, incluidos assets. |
| `public/*.html`, `public/assets/` | Recorrido CAPTCHA → DNI → resultado, envío POST y renderizado como texto. |
| `src/index.js` | Rutas, Siteverify, firma/validación del pase, sesión y RPC. |
| `src/security.js` | Validación de entradas, límites y adaptadores opcionales de identidad. |
| `wrangler.jsonc` | Modo público explícito, cuatro bindings y observabilidad. |
| `test/`, `scripts/` | Regresiones de seguridad, runtime nativo, navegador y verificaciones acotadas. |
| `.github/`, `package*.json`, documentación | Dependencias, CI, publicación manual y operación. |

Las cabeceras de `_headers` cubren contenido estático. Si se agregan Pages Functions, deberán emitir sus propias cabeceras.

## Verificación efectivamente realizada

| Prueba | Resultado |
| --- | --- |
| Node y workerd/Miniflare | **49 pruebas aprobadas, 0 fallos** en la revisión local. Incluyen reglas de carreras, horas, francos e imprevistos. |
| Pase ausente, alterado, vencido, futuro, TTL excesivo, origen o sujeto incorrecto | Rechazo sin consulta al origen de datos. |
| CAPTCHA ausente, inválido, reutilizado, hostname/action/fecha incorrectos | Rechazo con Siteverify simulado; no se afirma haber reutilizado un CAPTCHA real. |
| Otro DNI en modo público | Consulta permitida con datos ficticios. Confirma el riesgo abierto. |
| Otro empleado en modo opcional con identidad | Rechazado. Ese control no está activo en `public-captcha`. |
| Entradas malformadas, extras, JSON excesivo, métodos y CORS | Rechazo; sin llamada RPC para entradas inválidas. |
| Límites simulados y bindings locales nativos | Respuestas 429 con Retry-After; ausencia de binding falla cerrada. |
| Navegador Edge local | Flujo completo con servicios ficticios, sesión, historial, caducidad y formulario oculto ante fallo/sin JavaScript. |
| Payloads de XSS y CSP en navegador | Payloads como texto sin ejecución; scripts inline, encuadre y envío nativo del formulario bloqueados. No se confirmó un XSS explotable en el renderizado revisado. |
| `npm run check` | Bundle/dry-run correcto. |
| `npm audit` | 0 vulnerabilidades reportadas en el árbol revisado; no equivale a seguridad integral. |
| Publicación: siete rutas estáticas y cuatro respuestas de protocolo | Cabeceras y caché esperadas; API: 204/405/204/403. No hubo consultas personales. |
| Navegador en producción | Acceso directo sin pase volvió al CAPTCHA, sin formulario DNI y con Turnstile presente. No se resolvió el CAPTCHA ni se consultó DNI en ese control automatizado. |

Las ejecuciones posteriores de CI están disponibles en [GitHub Actions](https://github.com/gabyboan/consulta-horas/actions/workflows/security.yml). La evidencia operativa detallada se conserva fuera del repositorio público; no se publican inventarios privados de cuentas ni logs de producción.

## Identidad del empleado

Hay dos adaptadores preparados y desactivados:

1. `supabase`: valida Auth en servidor, obtiene una única relación autorizada con el empleado mediante RLS y vincula el pase al sujeto. Rechaza relaciones inexistentes o ambiguas y DNI ajenos.
2. `service`: usa un binding privado `EMPLOYEE_AUTH` conectado a un directorio institucional; no acepta un endpoint enviado por el cliente.

Para activarlos faltan la aprobación de otro modelo de acceso, identidad para cada empleado lector, una relación cuenta/empleado única y verificada, políticas institucionales de altas/bajas/recuperación y un frontend de inicio de sesión probado en staging. Las cuentas de RR. HH. no sustituyen esas identidades. No se crearon cuentas, correos verificados ni recuperación.

## Riesgos y límites pendientes

- Sigue abierta la consulta de DNI ajeno en el modo público solicitado, incluida la exposición de los datos que devuelve la funcionalidad existente.
- Los límites son aproximados por ubicación y pueden afectar IP compartidas o resultar insuficientes ante tráfico distribuido. No son un cupo global estricto ni autorización.
- El pase bearer está en `sessionStorage` y es reutilizable durante su vigencia. La CSP no lo convierte en una cookie HttpOnly ni garantiza ausencia de XSS.
- No hay dominio propio para configurar reglas WAF de zona en el despliegue actual. Ver [requisitos de WAF](docs/DEPLOYMENT.md#waf-y-dominios).
- Las advertencias del sistema Supabase compartido requieren su propia revisión; no se cambiaron permisos de aplicaciones ajenas a este portal.
- El código no elimina registros históricos con DNI en URL. La retención de logs y la protección de las cuentas requieren operación continua.
- No se verificó una consulta positiva con datos personales reales en producción. El flujo completo y los casos adversos se probaron con datos ficticios.

## Referencias oficiales

- [Cabeceras de Cloudflare Pages](https://developers.cloudflare.com/pages/configuration/headers/).
- [Siteverify: validación, caducidad y uso único](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
- [Turnstile y CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
- [Request y redirecciones en Workers](https://developers.cloudflare.com/workers/runtime-apis/request/).
- [Límites nativos de Workers](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- [Supabase: protección de la API](https://supabase.com/docs/guides/api/securing-your-api).
- [Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
