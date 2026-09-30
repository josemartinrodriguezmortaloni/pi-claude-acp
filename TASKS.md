# Tareas

Referencia: [specs/pi-claude-acp.md](specs/pi-claude-acp.md).

## Hecho

- [x] Toolchain: bun, TypeScript 6 (`tsc --noEmit`, strict), Biome, vitest, ESLint solo para el gate de complejidad (V(G) < 4), `.githooks/`.
- [x] `connection.ts`: resolución y validación del binario `claude`, lanzamiento del adaptador 0.84.0, handshake ACP, router por sesión, log en `getAgentDir()/claude-acp/adapter.log`.
- [x] `catalog.ts`: modelos y effort desde `configOptions`, placeholders 128000/16384/cost 0, mapeo de thinking, carga inicial con timeout de 15 s.
- [x] `sessions.ts`: `settingSources: []`, hook `PreToolUse` "ask", modo `default`, bloque de contexto de Pi, MCP de `~/.pi/agent/mcp.json`, persistencia y reanudación, divergencia de rama, cola por sesión, sesiones descartables para llamadas internas, cancelación de la compactación de Pi.
- [x] `stream.ts`: chunks, tool calls como texto, plan, fin de turno, usage y costo, abort, imágenes.
- [x] `permissions.ts`: puente `claude-acp:tool-request`, UI de Pi, filtro de `allow_always`.
- [x] `index.ts`: registro del provider y handlers.
- [x] Smoke test real (`bun run smoke`) y carga en Pi (`pi -e ./src/index.ts`).

## Pendiente

- [ ] Plugin validador en TS contra el contrato de §5.5 (fuera de alcance, otra sesión).
- [ ] Plugin de self-compact: toma `session_before_compact` y se quita el handler de `index.ts`.
