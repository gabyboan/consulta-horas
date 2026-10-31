# Contribuir

1. Crear una rama desde `main` y describir el problema que se corrige.
2. Mantener el recorrido CAPTCHA → DNI → resultado y la funcionalidad de horas y beneficios.
3. Usar datos ficticios y servicios simulados. No incluir información personal, credenciales ni logs de producción.
4. Ejecutar `npm test`, `npm run check` y `npm audit --audit-level=low`. Si cambia el frontend, ejecutar también las [pruebas de navegador](docs/DEVELOPMENT.md#frontend-y-pruebas-de-navegador).
5. Abrir un pull request con cambios, verificaciones reales y configuración necesaria. Actualizar la documentación si cambia el comportamiento.

Cambios de identidad, datos devueltos, orígenes, límites y secretos requieren revisar sus efectos con el responsable institucional. Consultar [SECURITY.md](SECURITY.md) antes de reportar un hallazgo sensible.
