# pi-claude-acp

Extensión de Pi que ejecuta un modelo de Anthropic a través de Claude Code y ACP. Para el usuario, la conversación ocurre con el modelo dentro de Pi. Claude Code queda como un detalle interno.

## Language

**Harness**:
Pi: la aplicación que el usuario ve y la dueña de toda la UI: el transcript, los diálogos, las notificaciones y los atajos.
_Avoid_: cliente, frontend

**Agente**:
El proceso de Claude Code que ejecuta el turno y sus herramientas. La UI nunca lo nombra.
_Avoid_: backend, Claude Code (en textos visibles)

**Ráfaga**:
Las herramientas que el agente usa seguidas, entre dos textos o razonamientos del modelo.
_Avoid_: batch, grupo

**Entrada de herramienta**:
La representación de una ráfaga en el transcript: una línea de resumen, una rama por herramienta y un detalle que se puede expandir.
_Avoid_: comentario, tool block, tarjeta

**Modo**:
La política con la que el agente pide permiso durante la sesión. Los valores son Manual, Ediciones automáticas y Plan.
_Avoid_: permission mode, perfil, Aceptar ediciones

**Subagente**:
Un agente que el agente principal lanza para una subtarea. En la entrada de herramienta aparece como una rama, con sus propias herramientas debajo.
_Avoid_: task, agente hijo

**Detalle**:
El contenido de una entrada de herramienta debajo de su línea: la salida, el diff o el contenido del archivo. El usuario lo expande o lo contrae para todas las entradas a la vez.
_Avoid_: output, body

**Aviso**:
Un mensaje del harness sobre el estado de la sesión, no sobre el trabajo del turno, por ejemplo "se perdió el historial". Nunca aparece dentro de la respuesta del modelo.
_Avoid_: notice, notificación del agente

**Razonamiento**:
El thinking que el modelo emite antes de responder o de usar una herramienta.
_Avoid_: chain of thought, pensamiento
