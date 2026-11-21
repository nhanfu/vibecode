# VS Code plugin

Shows Visual Studio Code in the Plugins panel, served by [openvscode-server](https://github.com/gitpod-io/openvscode-server) (MIT).
The app starts it on a free localhost port and shows it in an iframe, like DBX.

## Build

`build.sh` produces `server/` (the program the sidecar runs). It works in one of two ways, set in `plugin.json` under `source`:

- **Release build (default):** leave `source.git` empty. The script downloads the openvscode-server release for `version` and this system (about 240 MB unpacked).
- **From source:** set `source.git` to a repository URL. The script clones it into `source/`, checks out `source.ref` if set, runs `source.build` in the clone, and copies the folder `source.output` (relative to the clone) to `server/`. The output must contain `bin/openvscode-server`.

```json
"source": {
  "git": "https://github.com/you/openvscode-server.git",
  "ref": "my-changes",
  "build": "<the command that builds the server>",
  "output": "<the folder it produces>"
}
```

`build` and `output` depend on the repository. Check its README for the exact commands; they are not filled in here.

Run `./plugins/vscode/build.sh` after each change to the source. The script updates the clone and rebuilds.

## Install

- Plugins panel → Install from folder → `plugins/vscode` (after `build.sh`).
- Turn it on, then Start.

## Notes

- The server listens on 127.0.0.1 only and has no connection token, because the iframe cannot pass one. Any local process can reach it while it runs.
- It runs with your user's rights, and extensions run inside that server.
- Desktop-only features (native menus, several windows, native file dialogs) are not available.

## Lean on purpose

The plugin is for reviewing code and diffs, so it carries less than a full VS Code:

- `prune-extensions.sh` (run by `build.sh`) drops the built-in extensions that are not needed: debuggers, accounts and GitHub, notebooks, task detectors, extra colour themes. **Language support is kept whole**: every `*-language-features` (the language servers), every grammar, git, diff and merge-conflict. Edit the `DROP` list there to change it; the script refuses to drop an extension another one needs.
- The app starts the server program itself (`server/node server/out/server-main.js`), not the `bin/openvscode-server` script: that script does not `exec` node, so stopping the script left the real server running. Each sidecar also has a process group of its own, which is stopped as a whole, and a sidecar the last run left behind is stopped when the app starts.
