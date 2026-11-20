# Plugins

A plugin is a folder with a `plugin.json`. The app finds it, and what the manifest declares appears
in the app. The app never learns what a plugin does: **DBX**, the first one, is a manifest plus a
build script (`plugins/dbx/`).

## Where plugins live

| Folder | What for |
| --- | --- |
| `plugins/<id>/` of the checkout, bundled as `resources/plugins/` in the installer | shipped with the app |
| `<userData>/plugins/<id>/` (`~/.config/TINJS Studio/plugins` on Linux) | installed by the user; wins over a shipped plugin of the same id |
| `$VIBE_PLUGINS_DIR/<id>/` | development |

## `plugin.json`

```json
{
  "id": "dbx",
  "name": "DBX",
  "version": "0.6.72",
  "description": "…",
  "license": "Apache-2.0",
  "homepage": "https://github.com/t8y2/dbx",
  "panel":   { "title": "Database", "icon": "database", "replaces": "db" },
  "sidecar": {
    "command": "bin/dbx-web",
    "args": [],
    "env": { "DBX_PORT": "{port}", "DBX_DATA_DIR": "{data}", "DBX_WEB_MCP_TOKEN": "{token}" },
    "health": "/api/connection/list",
    "url": "/",
    "autostart": true
  },
  "mcp": { "name": "vibe-dbx", "path": "/mcp", "bearer": true }
}
```

- **`sidecar`** — a program the app starts on a free `127.0.0.1` port with a random token, waits for
  (`health` answers 2xx), and stops when the app closes. `command` is relative to the plugin's
  folder. In `args` and `env`, `{port}`, `{token}`, `{dir}` (the plugin's folder) and `{data}` (a
  private data folder, `<userData>/plugin-data/<id>`) are filled in. `autostart` starts it with the
  app (needed for an `mcp` server chats should have from their first message).
- **`panel`** — shows the sidecar's page (`url`) in a frame. `replaces` names a built-in panel it takes
  over (`"db"`: the Database tab); the built-in one stays one click away, and is what shows when the
  plugin is not built.
- **`mcp`** — an MCP server (a path on the sidecar) added to every chat's `--mcp-config`, next to the
  app's own `vibe-browser` and `vibe-mssql`.

A plugin whose sidecar program is missing is listed as not available and ignored.

## Code

- `src-tauri/src/plugins.rs`: discovery, the sidecar supervisor, `plugin_list` and `plugin_start`.
- `src-tauri/src/mcp.rs`: adds each plugin's MCP server to a chat's config.
- `src/renderer/src/components/PluginPane.tsx`: the frame; `DbPanel` in `Editor.tsx` picks the plugin
  that replaces `db`.

## Not yet

A panel of its own (a new title-bar button) for a plugin that replaces nothing, a plugin manager UI
(install, remove, update), and plugins that run code in the renderer. The manifest is the contract
those will extend; nothing in it needs to change for them.
