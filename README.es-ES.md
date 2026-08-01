

# Covel

**Un RPG de IA moderno y basado en agentes. Personaliza cada mecánica con un plugin.**

**Inglés** · [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.0.23-8b5cf6)](https://github.com/ackness/covel/releases/tag/v0.0.23)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stage](https://img.shields.io/badge/stage-early--access-orange)](<>)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ackness/covel)

![Covel demo — one full session at 6× speed](./.assets/images/demo.gif)

Covel es un RPG de IA donde el mundo sigue funcionando entre tus turnos: los NPC rastrean cómo se sienten hacia ti, el lore se acumula a medida que juegas y la memoria mantiene el hilo a lo largo de la sesión. Cada mecánica detrás de eso es un **agente autónomo distribuido como plugin** — desactívalo, cámbialo o escribe el tuyo propio.

> **Lanzamiento público actual: v0.0.23**, acceso anticipado — las APIs, los formatos de datos y el frontmatter de los plugins pueden cambiar entre versiones. Los binarios precompilados están dirigidos a macOS Apple Silicon y Windows x64; otras plataformas deben compilarse desde el código fuente.

## Destacados

- 🎭 **Modo Escenario** — una novela visual a pantalla completa: fondos de escena, sprites de personajes, diálogos tipo máquina de escribir y superposiciones de elección. Los fondos para ubicaciones completamente nuevas se generan bajo demanda, en medio de la sesión.
- 🤖 **Turnos multiagente** — mientras el narrador escribe la escena, otros agentes extraen relaciones de NPC, expanden el códice del mundo, seleccionan el elenco en escena y mantienen la memoria a largo plazo — en paralelo, cada turno.
- 🧩 **Todo es un plugin** — 23 agentes incluidos. Un plugin es un `PLUGIN.md`: frontmatter YAML para disparadores/herramientas/eventos, y el cuerpo en markdown como el prompt del agente.
- 🌍 **Dos mundos insignia** — un misterio de fantasía oscura y una novela romántica escolar de estilo novela visual, ambos construidos a mano y listos para hacer fork.
- 🔌 **Usa tu propio modelo** — ranuras para modelos de OpenAI / Anthropic / DeepSeek / Qwen. Primero local: SQLite en disco, las claves de API nunca se persisten en el servidor.

## Dos formas de jugar

|                                 Modo Escenario (novela visual)                                 |                                     Modo Historia (texto)                                      |
| :----------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------: |
|                   ![Stage mode](./.assets/images/readme/stage-mode.png)                    |                    ![Story mode](./.assets/images/readme/text-mode.png)                    |
| Fondos, sprites y diálogos tipo máquina de escribir; el arte de escena se resuelve y genera mientras exploras | Turnos narrados clásicos con elecciones inline, formularios y la línea de tiempo de agentes por turno visible |

Los mundos declaran su valor predeterminado (`defaultViewMode: stage`); puedes cambiarlo en cualquier momento durante la sesión.

## Lo que dejan los agentes

![Core memory panel](./.assets/images/readme/memory-panel.png)

Abre un panel lateral en medio de la partida y estarás leyendo lo que los agentes en segundo plano escribieron este turno: memoria central (trama en curso, escena actual, estado del jugador), el gráfico de relaciones de NPC, el códice del mundo y el elenco en escena. Nada de ello está escrito a mano — se acumula mientras juegas y es lo que el narrador lee en el siguiente turno.

## Inicio rápido

### Jugar

Descarga la versión para **macOS Apple Silicon** o **Windows x64** desde [Releases](https://github.com/ackness/covel/releases), luego: abre Configuración → pega una clave de API de LLM → elige un mundo → juega.

Tus datos se almacenan en `~/.covel/` (configuración, claves, SQLite, mundos personalizados, registros) — detalles en la [guía de configuración de escritorio](./docs/guide/desktop-config.en.md). Notas por versión: [`docs/CHANGELOG.md`](./docs/CHANGELOG.md).

### Ejecutar desde el código fuente

```bash
pnpm install
cp llm.toml.example llm.toml        # model IDs and endpoints
cp .env.llm.example .env.llm        # provider API keys
pnpm dev                            # web :5173 + server :3001 (SQLite)
```

Abre <http://localhost:5173> — las herramientas de depuración están en `/debug`. PostgreSQL, modo en memoria y otros ajustes: [registro de entornos](./docs/guide/env-registry.md).

## Mundos incluidos

![World select](./.assets/images/readme/select-world.png)

- **Mistport Chronicles** (雾港·裂潮纪) — misterio de fantasía oscura en modo historia tradicional. Un puerto envuelto en niebla donde cada marea revela ruinas diferentes; un maestro de gremio desaparece y cuatro poderes compiten por una llave hacia lo que duerme en las profundidades. Bilingüe, con un elenco inicial y una memoria con sabor a investigación.
- **Haruka Academy** (遥风学园) — romance escolar en modo escenario. Clubes, exámenes, rumores y crushes silenciosos en una escuela secundaria a orillas del mar, narrado a través de un elenco de ocho — retratos y arte de escena incluidos.

## Crea el tuyo propio

Abre Claude Code en este repositorio y usa las habilidades incluidas:

- **`/create-world`** — describe un entorno; obtén un `world.yaml` + `WORLD.md` + datos del mundo validados, listos para `~/.covel/worlds/`.
- **`/create-plugin`** — describe el agente que quieres; obtén un `PLUGIN.md` + `package.json` validados.

Un centro oficial para compartir plugins y paquetes de mundos está en la hoja de ruta — por ahora, compártelos mediante Gist o haciendo fork.

## Desarrollo

- [Guía de creación de plugins](./docs/guide/plugin-authoring.md) — comienza aquí; los plugins incluidos en [`plugins/`](./plugins/) son referencias funcionales
- [Arquitectura y pipeline de turnos](./docs/architecture/flow.md) — cómo fluye un turno a través de disparador → programación → agentes → confirmación
- Referencia: [registro de plugins](./docs/reference/plugins.md) · [registro de herramientas](./docs/reference/tools.md) · [API HTTP](./docs/reference/api.md) · [índice completo de documentación](./docs/README.md)

pnpm workspaces + Turborepo · Solo ESM · TypeScript estricto · React 19 + Hono + Drizzle. Estructura del repositorio y lista de paquetes → [`CLAUDE.md`](./CLAUDE.md#monorepo-structure).

## Hoja de ruta

- Compilaciones para Linux / Mac Intel (macOS arm64 y Windows x64 ya están disponibles)
- Centro oficial de la comunidad para plugins y paquetes de mundos
- Mercado de plugins dentro de la aplicación de escritorio

## Contribuir y licencia

Se aceptan issues y PRs — por favor lee [`docs/CONTRIBUTING.en.md`](./docs/CONTRIBUTING.en.md) primero. Los lanzamientos se basan en tags: empujar `v*` compila y publica el instalador de macOS a través de [GitHub Actions](./.github/workflows/release.yml).

[MIT](./LICENSE) © 2026 Covel Contributors
