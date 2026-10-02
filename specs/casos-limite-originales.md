# Casos límite de la especificación original

Fuente: especificación original de `pi-claude-acp`, provista por el usuario el 2026-09-30. [pi-claude-acp.md](pi-claude-acp.md) §6 los mantiene con ajustes. Cada caso tiene un test con el prefijo `C<n>` en `test/`.

## connection.ts

1. CLAUDE_CODE_EXECUTABLE no existe o no es ejecutable: error antes de lanzar el adaptador, con la ruta probada.
2. El adaptador no arranca o termina a mitad de un stream: el stream en curso termina con un evento de error que incluye el código de salida y las últimas líneas de stderr del adaptador; las sesiones de esa conexión se marcan inválidas y la próxima request relanza la conexión.
3. Claude Code sin login o el adaptador pide autenticación: aviso al iniciar la sesión de Pi y, si el turno falla, error que indica ejecutar `/claude-login`. El comando le cede la terminal a `claude auth login`; el login lo hace el binario y la extensión no maneja credenciales.
4. La extensión no escribe en stdout ni stderr del proceso de Pi, porque rompe la TUI. El stderr del adaptador va a un buffer acotado y a un archivo de log de la extensión.
5. Pi se cierra o descarga la extensión: el proceso del adaptador termina sin dejar procesos huérfanos.

## sessions.ts

6. Sesión de Pi reanudada tras reiniciar Pi: el mapeo piSessionId → sessionId de ACP persiste junto a la sesión de Pi. Si el agente anuncia resume o load, se reanuda; si no, o si falla, se abre una sesión nueva y un aviso de Pi (`ui.notify`) dice que el modelo no tiene el historial previo.
7. Branch, fork o edición de un mensaje anterior en Pi: el historial de Pi deja de coincidir con el del agente. Se abre una sesión ACP nueva y un aviso de Pi (`ui.notify`) dice que el contexto del modelo se reinició.
8. Dos prompts simultáneos sobre la misma sesión: se serializan; el segundo espera al fin del primero.
9. El cwd de la sesión ACP es la ruta absoluta del cwd de Pi al crear la sesión.
10. Pi invoca al provider para tareas internas que no son turnos del usuario (por ejemplo, el resumen de compactación): van a una sesión ACP descartable y nunca a la sesión del usuario.

## catalog.ts

11. Pi pide el catálogo antes de que exista una sesión: al registrar el provider se abre la conexión y una sesión de arranque. Si falla, el provider se registra con catálogo vacío, se muestra el error y se reintenta en el próximo uso.
12. Un modelo sin configOption effort: no se envía effort.
13. Nivel de thinking de Pi sin equivalente ofrecido para ese modelo: se usa el nivel ofrecido más cercano por debajo; off y minimal van al nivel más bajo ofrecido.
14. Cambio de modelo o de thinking a mitad de sesión: set_config_option sobre la sesión existente antes del próximo prompt. Si el adaptador lo rechaza, error visible; nunca seguir en silencio con otro modelo.
15. Modelo seleccionado que ya no figura en el catálogo (por ejemplo, claude-opus-5-5 con un binario viejo): error que nombra el binario usado y la lista de modelos disponibles.
16. Campos del Model de Pi que ACP no informa (ventana de contexto, precios): placeholders (ver §5.2).

## stream.ts

17. Mapeo: chunks de mensaje → text; chunks de pensamiento → thinking; tool_call y sus updates → texto con nombre, estado y resultado resumido; plan, comandos o modo → texto o ignorados. Un tipo de update desconocido devuelve undefined, se registra en el log y no corta el stream.
18. Motivos de fin: fin normal → done; cancelado → abortado; límite de tokens, límite de turnos o rechazo → error de Pi con el motivo.
19. Usage ausente o parcial: valores en 0 sin romper el stream.
20. Abort desde Pi: session/cancel, las requests de permiso pendientes se responden como canceladas y el stream termina como abortado.
21. Updates de otra sesión o posteriores al fin del turno: se descartan por sessionId y estado del turno.
22. Mensaje del usuario con imágenes: se envían si el agente anuncia soporte de imágenes; si no, error explícito, nunca descarte silencioso.

## permissions.ts

23. Política: la UI de Pi muestra la herramienta, el comando o ruta afectada y las opciones de la request; se devuelve la opción elegida. Nunca auto-aprueba (§5.5 suma el puente de validadores).
24. Sin UI disponible (modo no interactivo o impresión): se rechaza la request.
25. Request de permiso que llega durante una cancelación: se responde cancelado.
