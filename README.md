# aparte

Mod para [Claude Code](https://claude.com/claude-code): un chat lateral para preguntar sobre la conversación sin gastar su contexto.

```
/aside ¿por qué eligió esa librería y no la otra?
```

La pregunta y su respuesta se quedan en el panel **Aside**: el hilo principal nunca las ve, así que no ocupan su ventana de contexto ni desvían la tarea en curso.

## Cómo funciona

- `/aside <pregunta>` abre el panel y pregunta. El panel tiene su propio campo para seguir preguntando.
- Cada respuesta sale de una bifurcación de la conversación tal como quedó en su último turno: mismo modelo y mismo prompt de sistema, servida desde la caché de prompts y sin acceso a herramientas.
- Antes de que termine el primer turno todavía no hay nada que bifurcar. Entonces responde «en vivo» con un modelo ligero sobre el texto de la conversación, o espera en cola a que termine el turno, según la opción `liveFallback`.
- Bajo cada respuesta, una línea con lo que costó: tiempo, tokens servidos de caché, tokens sin caché y tokens de salida.
- `/aside limpiar`, o el botón **Limpiar**, borra el historial del panel.

Las respuestas salen en español, breves y en prosa.

## Opciones

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `liveFallback` | `true` | Responder «en vivo» antes de que termine el primer turno. Desactivada, la pregunta espera en cola. |
| `liveModel` | `haiku` | Modelo de las respuestas «en vivo». La bifurcación usa siempre el modelo de la sesión. |
| `maxHistory` | `8` | Cuántos intercambios anteriores del panel acompañan a cada pregunta nueva (1 a 50). |

## Instalación

En el prompt de una sesión de terminal:

```
/plugin install aparte --marketplace zrdqns/claude-code-aparte
```

Responde `y` para añadir el marketplace y elige el alcance (el de usuario lo carga en todas las sesiones, también en las de la app de escritorio).

Para probarlo desde una copia local, sin instalarlo:

```bash
claude --plugin-dir ./claude-code-aparte
```

## Desarrollo

```bash
claude plugin validate .
claude plugin test .
```

El módulo está en [`hooks/register.tsx`](hooks/register.tsx), su contrato de estado en [`types/index.d.ts`](types/index.d.ts) y los tests en [`tests/`](tests).
