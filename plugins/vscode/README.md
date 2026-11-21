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
