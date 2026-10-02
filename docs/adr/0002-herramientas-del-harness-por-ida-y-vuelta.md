# Ejecutar las herramientas del harness con ida y vuelta por Pi

El agente no veía las herramientas que registran Pi y sus extensiones (`eval`, `codemode`). Ahora la extensión sirve un MCP HTTP en `127.0.0.1` y lo pasa en `newSession`. Ese MCP ofrece todas las herramientas activas de Pi, menos las que el agente ya tiene de forma nativa (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`) y menos la herramienta espejo. Cuando el agente llama a una de ellas, el MCP retiene la llamada. El provider cierra el mensaje de Pi con un `toolCall` real a esa herramienta. Pi la ejecuta con su renderer, sus validadores y su sesión. Cuando Pi emite `tool_execution_end` para esa llamada, el MCP responde la llamada retenida con el resultado. No espera a la siguiente llamada a `streamSimple`, porque esa llamada solo llega cuando terminan todas las herramientas del mensaje.

## Considered Options

- **Ejecutar dentro de la herramienta espejo con `ctx.executeTool`**: no corta la ráfaga, pero `executeTool` rechaza las herramientas `model-only` como `eval`, y el resultado queda dentro de la entrada de actividad en lugar de ser una herramienta propia del transcript.
- **Exponer todas las herramientas de Pi**: el agente vería dos `bash` con semánticas distintas.
- **Lista blanca explícita**: cada extensión nueva obligaría a cambiar pi-claude-acp.

## Consequences

- Cuando llega una herramienta del harness, la ráfaga en curso termina. Sus herramientas nativas que siguen corriendo pasan a una ráfaga nueva, y el provider cierra el siguiente mensaje de Pi con la herramienta del harness seguida de esa herramienta espejo. El orden importa: si una herramienta del mensaje es `sequential`, como `agent_activity` o `eval`, Pi corre todo el mensaje en serie (`pi-agent-core/dist/agent-loop.js:368`), y una herramienta espejo primero esperaría un texto que el agente no puede escribir sin el resultado del harness.
- Las herramientas del harness pasan por el mismo Modo que las nativas: el hook `PreToolUse` no las excluye.
- La máquina de estados de ADR 0001 ahora también continúa el turno ACP cuando el último `toolResult` es de una herramienta del harness.
- La lista de herramientas sale de `getCurrentTools(messages)` en cada llamada a `streamSimple`, no de `context.tools`, que Pi 0.99.2 ya no envía.
