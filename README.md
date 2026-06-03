# Consulta de Horas

Página pública y Worker de Cloudflare para consultar horas disponibles del personal.

## Arquitectura

- `public/`: sitio estático desplegado en Cloudflare Pages.
- `src/index.js`: API server-side desplegada como Cloudflare Worker.
- Supabase se consulta únicamente desde el Worker con `SUPABASE_SERVICE_ROLE_KEY`.
- Turnstile se valida en el Worker antes de ejecutar la RPC.

## Seguridad

Los secretos no deben guardarse en Git. Configuralos en Cloudflare como secretos del Worker:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_SECRET
```

La API devuelve solo el DNI enmascarado y los datos necesarios para la consulta. El RPC de Supabase debe permitir ejecución a `service_role`, no a `anon`.

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

El workflow `.github/workflows/deploy.yml` despliega automáticamente al hacer push a `main`.
Configura estos secretos en GitHub Actions:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

El token debe tener únicamente los permisos necesarios para editar Workers y Pages.
