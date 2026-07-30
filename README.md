# Consulta de Horas

[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-frontend-f38020?logo=cloudflare&logoColor=white)](https://hesm-horas.pages.dev/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-api-f38020?logo=cloudflare&logoColor=white)](#arquitectura)
[![Supabase](https://img.shields.io/badge/Supabase-rpc_datos-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![Turnstile](https://img.shields.io/badge/Turnstile-anti_abuso-111111?logo=cloudflare&logoColor=white)](#seguridad)

Portal publico para consultar horas disponibles del personal. El sitio separa
frontend estatico, API en Cloudflare Worker, validacion anti-abuso con
Turnstile y acceso controlado a Supabase mediante RPC.

## Enlaces

- Sitio: https://hesm-horas.pages.dev/
- Repositorio: https://github.com/gabyboan/consulta-horas

## Arquitectura

```txt
Usuario
  -> Cloudflare Pages
  -> Cloudflare Worker
  -> Turnstile
  -> Supabase RPC
```

| Capa | Responsabilidad |
| --- | --- |
| `public/` | Sitio estatico desplegado en Cloudflare Pages. |
| `src/index.js` | API server-side desplegada como Cloudflare Worker. |
| Turnstile | Validacion anti-abuso antes de consultar datos. |
| Supabase | RPC ejecutada desde el Worker con credenciales protegidas. |

## Seguridad

- Los secretos no se guardan en Git.
- El frontend no recibe `service_role`.
- Turnstile se valida en el Worker antes de ejecutar la RPC.
- El Worker exige que el token haya sido emitido para `hesm-horas.pages.dev`.
- Cada DNI admite hasta 5 consultas por minuto.
- La API devuelve DNI enmascarado y solo los datos necesarios para la consulta.

Configurar secretos en Cloudflare:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_SECRET
```

## Desarrollo

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev:worker
```

## Despliegue

```bash
npm run deploy:worker
npm run deploy:pages
```

El workflow `.github/workflows/deploy.yml` despliega automaticamente al hacer
push a `main`.

Secretos y variables esperadas en GitHub Actions:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

El token debe tener un alcance minimo para editar Workers y Pages.

## Muestra preliminar: saldos y beneficios

La rama `preliminar-saldos-y-imprevistos` prepara la interfaz para una muestra
sin modificar el sitio publicado. Incluye `public/muestra-preliminar.html`, una
vista estática con datos ficticios para revisar el diseño.

La RPC `rpc_consulta_horas_public` debe ampliar su respuesta con estos campos:

| Campo | Tipo | Regla de presentación |
| --- | --- | --- |
| `horas_a_favor_hhmm` | texto `HH:MM` o `null` | Se muestra como horas a favor. |
| `francos_disponibles` | entero mayor o igual a 0 o `null` | La tarjeta se muestra siempre; si el dato aún no está informado muestra `—`. |
| `imprevistos_disponibles` | entero mayor o igual a 0 o `null` | La tarjeta se muestra incluso con `0`; `null` u omitir el campo significa que la persona no posee el beneficio y la tarjeta no se muestra. |

El Worker valida los tipos antes de enviarlos al navegador. La migración o
actualización de la RPC debe realizarse en el repositorio que administra la
base de Supabase; este repositorio sólo contiene el Worker y el frontend.
