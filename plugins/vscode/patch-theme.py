#!/usr/bin/env python3
"""Makes VS Code (openvscode-server) follow VIBE CODE's theme, and take its settings from the app.

The web client keeps the user's settings in the browser (IndexedDB of the iframe), not in the
server's data/User/settings.json, and a theme picked by hand in VS Code beats anything the server
could write. So the page itself decides: the app opens it with
  ?vibeTheme=light|dark        the app's resolved theme ("system" included)
  ?vibeSettings=<base64 JSON>  the contents of the plugin's settings.json (optional)
and this patch puts them into the workbench configuration before the workbench starts:
  - window.autoDetectColorScheme with the Default Dark / Light Modern themes as the pair, and
    prefers-color-scheme answering with the app's theme (the browser's own answer is the OS's, which
    is not the app's when the app is set to light or dark by hand). With auto-detect on, VS Code
    ignores workbench.colorTheme, so the app's theme always wins.
  - the settings.json keys as configurationDefaults (lowest priority: settings changed inside VS Code
    still win over them), except the theme keys above.
  - a theme the user picked by hand in VS Code is stored at the user level and would beat both of the
    above, so before the workbench starts those theme keys are removed from the browser's stored
    settings (the workbench is loaded after that, from a small script).
Idempotent. Usage: patch-theme.py <server/out/vs/code/browser/workbench/workbench.html>
"""
import sys

MARK = "VIBE CODE: theme and settings"
ANCHOR = '<meta id="vscode-workbench-web-configuration" data-settings="{{WORKBENCH_WEB_CONFIGURATION}}">\n'
PATCH = ANCHOR + """
		<script>
			// VIBE CODE: theme and settings from the address (see plugins/vscode/patch-theme.py)
			(function () {
				try {
					var q = new URLSearchParams(location.search);
					var forced = q.get('vibeTheme');
					var extra = {};
					var raw = q.get('vibeSettings');
					if (raw) {
						try {
							var b = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
							extra = JSON.parse(decodeURIComponent(escape(b)));
						} catch (e) {}
					}
					var el = document.getElementById('vscode-workbench-web-configuration');
					var cfg = JSON.parse(el.getAttribute('data-settings'));
					var defaults = Object.assign({}, cfg.configurationDefaults, extra);
					if (forced === 'light' || forced === 'dark') {
						delete defaults['workbench.colorTheme'];
						defaults['window.autoDetectColorScheme'] = true;
						defaults['workbench.preferredDarkColorTheme'] = 'Default Dark Modern';
						defaults['workbench.preferredLightColorTheme'] = 'Default Light Modern';
						var real = window.matchMedia.bind(window);
						window.matchMedia = function (query) {
							var list = real(query);
							var m = /^\\s*\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)\\s*$/.exec(query);
							if (m) Object.defineProperty(list, 'matches', { get: function () { return m[1] === forced; } });
							return list;
						};
					}
					cfg.configurationDefaults = defaults;
					el.setAttribute('data-settings', JSON.stringify(cfg));
				} catch (e) {}
			})();
		</script>
"""

LOAD = '<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.js"></script>\n'
LOAD_PATCHED = """<script>
		// VIBE CODE: theme and settings (see plugins/vscode/patch-theme.py): drop the theme the user picked
		// by hand in VS Code before the workbench reads its settings, then start it
		const THEME_KEYS = [
			'workbench.colorTheme',
			'window.autoDetectColorScheme',
			'window.autoDetectHighContrast',
			'workbench.preferredDarkColorTheme',
			'workbench.preferredLightColorTheme',
			'workbench.preferredHighContrastColorTheme',
			'workbench.preferredHighContrastLightColorTheme'
		];
		const dropThemeChoices = () => new Promise((resolve) => {
			const open = indexedDB.open('vscode-web-db');
			open.onerror = open.onblocked = () => resolve();
			open.onsuccess = () => {
				const db = open.result;
				try {
					if (!db.objectStoreNames.contains('vscode-userdata-store')) { db.close(); return resolve(); }
					const tx = db.transaction('vscode-userdata-store', 'readwrite');
					const store = tx.objectStore('vscode-userdata-store');
					const get = store.get('/User/settings.json');
					get.onsuccess = () => {
						if (!get.result) return;
						let settings;
						try { settings = JSON.parse(new TextDecoder().decode(get.result)); } catch (e) { return; }
						const had = THEME_KEYS.filter((k) => k in settings);
						if (!had.length) return;
						had.forEach((k) => delete settings[k]);
						store.put(new TextEncoder().encode(JSON.stringify(settings, null, 4)), '/User/settings.json');
					};
					tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
				} catch (e) { db.close(); resolve(); }
			};
		});
		(async () => {
			try {
				const forced = new URLSearchParams(location.search).get('vibeTheme');
				if ((forced === 'light' || forced === 'dark') && indexedDB.databases) {
					if ((await indexedDB.databases()).some((d) => d.name === 'vscode-web-db')) await dropThemeChoices();
				}
			} catch (e) {}
			// the NLS module scripts above have run once the document is loaded
			if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
			await import(new URL('{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.js', location.href).href);
		})();
	</script>
"""

path = sys.argv[1]
text = open(path, encoding="utf8").read()
if MARK in text:
    print("already patched")
elif text.count(ANCHOR) != 1 or text.count(LOAD) != 1:
    sys.exit("workbench.html is not as expected; the theme patch needs a look")
else:
    open(path, "w", encoding="utf8").write(text.replace(ANCHOR, PATCH, 1).replace(LOAD, LOAD_PATCHED, 1))
    print("patched", path)
