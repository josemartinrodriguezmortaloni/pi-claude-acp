# Segmentar el turno con herramientas espejo

Pi solo permite expandir y contraer componentes de herramienta, de mensaje custom o de entry. El texto que emite un provider no se puede colapsar. Por eso, cuando el agente empieza una ráfaga de herramientas, el provider cierra el mensaje de Pi con un `toolCall` a una herramienta espejo que registra la extensión. La herramienta espejo no ejecuta nada. Espera los resultados de esa ráfaga en el turno ACP, que sigue abierto, y los devuelve. Después Pi vuelve a llamar al provider, y el provider continúa el mismo turno ACP en lugar de enviar un prompt nuevo. Así el transcript respeta el orden real entre texto y herramientas, usa el Ctrl+O nativo de Pi, y la sesión de Pi guarda las entradas.

## Considered Options

- **Markdown dentro del mensaje** (la solución anterior): no se puede colapsar.
- **`pi.appendEntry` con un entry renderer**: Pi inserta la entry antes del mensaje en curso, así que las herramientas quedan arriba del texto que las precede.
- **`pi.sendMessage`**: el mensaje se encola hasta el final del turno, y Pi lo envía al modelo como mensaje de usuario.

## Consequences

- El provider pasa a ser una máquina de estados que abarca varias llamadas a `streamSimple`. Una llamada cuyo último mensaje es un `toolResult` continúa el turno abierto y no envía prompt.
- Las herramientas espejo no pueden usar los nombres de las herramientas nativas de Pi (`read`, `edit`, `bash`, `write`). Con esos nombres, Pi ejecutaría la herramienta real otra vez.
- Las herramientas espejo solo están activas mientras el modelo activo es de `claude-acp`.
