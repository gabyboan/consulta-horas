# Seguridad

El alcance, los controles comprobados y los riesgos conocidos están en [SECURITY_REVIEW.md](SECURITY_REVIEW.md). La consulta pública mediante DNI no verifica la identidad del titular.

## Reportar un problema

No publicar DNI, resultados de empleados, credenciales, tokens o instrucciones de explotación sensibles en issues o pull requests públicos. Comunicar esos hallazgos al responsable institucional por un canal privado acordado fuera del repositorio.

Para problemas sin información sensible, incluir componente afectado, comportamiento observado y reproducción con datos ficticios. No ejecutar fuerza bruta, enumeración ni carga contra producción.

## Mantenimiento

Dependabot revisa npm y GitHub Actions semanalmente. CI ejecuta auditoría, pruebas funcionales y de seguridad, runtime workerd y navegador local. Revisar y probar cada actualización antes de integrarla; una auditoría sin avisos no certifica la seguridad del sistema.

Los secretos pertenecen al Worker y al almacén de secretos de CI. No deben formar parte del frontend ni de Git. Ver la [guía de despliegue](docs/DEPLOYMENT.md) para permisos, límites y configuración.
