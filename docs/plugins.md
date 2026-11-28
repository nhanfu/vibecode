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
  "panel":   { "title": "Database", "icon": "database" },
  "sidecar": {
    "command": "bin/dbx-web",
    "args": [],
    "env": { "DBX_PORT": "{port}", "DBX_DATA_DIR": "{data}", "DBX_WEB_MCP_TOKEN": "{token}" },
    "health": "/api/connection/list",
    "url": "/",
    "autostart": true
  },
  "mcp": { "name": "vibe-dbx", "path": "/mcp", "bearer": true },
  "minAppVersion": "0.2.0",
  "platforms": ["linux", "windows", "macos"]
}
```

`id` is lowercase letters, digits, `-` and `_`. `minAppVersion` and `platforms` are optional: a plugin that
needs a newer app, or has no build for this system, is listed as not available (and refused when installed).
The sidecar `command` must stay inside the plugin's folder.

- **`sidecar`** — a program the app starts on a free `127.0.0.1` port with a random token, waits for
  (`health` answers 2xx), and stops when the app closes. `command` is relative to the plugin's
  folder. In `args` and `env`, `{port}`, `{token}`, `{dir}` (the plugin's folder) and `{data}` (a
  private data folder, `<userData>/plugin-data/<id>`) are filled in. `autostart` starts it with the
  app (needed for an `mcp` server chats should have from their first message).
- **`panel`** — shows the sidecar's page (`url`) in a frame. Without `replaces` the plugin gets its own
  title-bar button while it is on and can run: `title` is its label and `icon` one of `code`, `database`,
  `globe`, `folder`, `bot`, `terminal`, `puzzle` (default). The panel shows while the plugin is on and its
  page is up. `"folder": true` opens the page on the project folder the sidebar shows (`?folder=`).
- **`sidecar.theme`** — `{ file, key, dark, light }`: before the sidecar starts, and when the app's theme
  changes, the setting `key` in `file` (relative to the plugin's data folder) is set to the `dark` or `light`
  value, keeping the rest of the file. The file must be plain JSON (no comments).
- **`mcp`** — an MCP server (a path on the sidecar) added to every chat's `--mcp-config`.

A plugin whose sidecar program is missing is listed as not available and ignored.

## The Plugins panel

A title-bar button (Ctrl+Shift+X, or the command *Show / hide Plugins*) opens the manager:

- **Installed**: every plugin found, with its status (running, starting, stopped, failed, off, not
  available), **Open**, **Start / Stop / Restart**, **Turn off / on**, **Logs** (the last 1000 lines the
  sidecar printed), **Details** (license, homepage, MCP server, port, *Start with the app*) and
  **Remove** (plugins you installed are deleted, asking whether to delete their data too; shipped and
  development ones are only hidden, and installing them again brings them back). A plugin that does not
  replace a built-in panel opens its page inside the manager, and also gets its own title-bar button.
- **Browse**: the plugins of a registry, with Install and Update (when the registry has a newer version).
- **Install bar**: a folder, a `.zip` / `.tar.gz` file, or an https link to one (with an optional SHA-256
  the download is checked against). The archive may have `plugin.json` at its top or one folder down.

Installing copies the plugin into `<userData>/plugins/<id>/`, replacing (and first stopping) an earlier
install. It always asks first: a plugin is a program that runs with your permissions. A download without a
checksum is allowed but flagged as unverified.

Settings (turned off, autostart, the registry address) are in `<userData>/plugin-settings.json`.

### The registry

An `index.json` served over https. The default is `plugins/index.json` of this repository (raw GitHub);
*change* in Browse points the app at another one.

```json
{
  "plugins": [
    {
      "id": "example",
      "name": "Example",
      "version": "1.2.0",
      "description": "…",
      "license": "MIT",
      "homepage": "https://…",
      "url": "https://…/example-1.2.0-linux.tar.gz",
      "sha256": "…hex…",
      "minAppVersion": "0.2.0",
      "platforms": ["linux"]
    }
  ]
}
```

Archives are per system: list one entry per platform build (same `id`, different `platforms` and `url`);
the manager only offers an entry that fits this system.

## Code

- `src-tauri/src/plugins.rs`: discovery, the sidecar supervisor (status, logs), install / uninstall,
  the registry, and the commands `plugin_list`, `plugin_start`, `plugin_stop`, `plugin_restart`,
  `plugin_set`, `plugin_logs`, `plugin_install`, `plugin_uninstall`, `plugin_registry`.
- `src-tauri/src/mcp.rs`: adds each plugin's MCP server to a chat's config.
- `src/renderer/src/components/PluginManager.tsx`: the Plugins panel.
- `src/renderer/src/components/PluginPane.tsx`: the frame, shown in the plugin's own panel (`Stack.tsx`).

## Not yet

A title-bar button of its own for a plugin that replaces nothing (it opens inside the manager for now),
signed registries (only an optional SHA-256 today), automatic update checks, and plugins that run code in
the renderer. The manifest is the contract those will extend; nothing in it needs to change for them.

## Renderer modules (experimental)

A plugin can bring a renderer module: `"renderer": "ui.js"` in its `plugin.json`, with the file at
`plugins/<id>/ui.js`. The file is an ES module exporting `activate(api)`, which the app calls at startup:

```js
export function activate(api) {
  api.addCommand({ id: 'hello-ui.hello', label: 'Hello from a renderer plugin', run: () => api.notify('Hi') })
}
```

- `api.addCommand({ id, label, run })` adds a command to the palette (Ctrl+Shift+P). Ids must be unique.
- `api.notify(text)` shows a message (for now an alert).

Only modules in the checkout's `plugins/` folder are loaded, and they are bundled into the app at build
time (`src/renderer/src/rendererPlugins.ts`). A change to `ui.js` reloads the window in dev; the app does
not restart. Installed (user) plugins and a permission prompt for modules are not done yet.
