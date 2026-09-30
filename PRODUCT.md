# Product

## Register

product

## Users

Devs que usan Pi como agente principal y ejecutan Claude Code a través de `pi-claude-acp`: el autor y otros devs que no conocen ACP. Escanean el transcript mientras el agente trabaja y lo revisan al final del turno. Responden los diálogos de permiso de Pi sin salir del flujo.

## Product Purpose

Mostrar el trabajo de Claude Code dentro de Pi de forma que se sepa de un vistazo qué hizo, sobre qué archivos o comandos, y si algo falló. Las superficies son el transcript de la terminal (texto, thinking, herramientas, plan, avisos, errores) y los diálogos de permiso. El éxito es revisar un turno sin releerlo y aprobar un permiso sabiendo exactamente qué se ejecuta.

## Brand Personality

Sobria, precisa, silenciosa. La interfaz desaparece detrás del trabajo del agente. La referencia es Amp: una línea por acción, el estado primero, el detalle apagado y la salida colapsada salvo que aporte.

## Anti-references

- El formato inicial de la extensión: título genérico de herramienta ("Terminal", "Read File"), `✓ completed` suelto sin dueño, fences dentro de fences y líneas en blanco entre todo.

## Design Principles

1. La actividad se escanea y la voz se lee: lo que hace el agente y lo que dice se distinguen por la forma.
2. El contenido aparece solo si cambia una decisión: los fallos y la salida de comandos se muestran, las lecturas y las búsquedas no.
3. El estado se entiende sin color.
4. El progreso se ve en vivo, pero el transcript no se reescribe.

## Accessibility & Inclusion

- El estado nunca depende solo del color: cada estado combina un símbolo con forma propia y, si falla, una palabra.
- Legible en tema claro y oscuro de Pi.
- Solo Unicode básico: nada de Nerd Fonts ni glifos que dependan de la fuente.
