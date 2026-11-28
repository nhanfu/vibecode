/*
 * Native plugin ABI, version 1. The app loads a plugin's library (plugin.json: "native"), looks up the three
 * functions below, and passes the host's table to vibe_plugin_init. The plugin runs in the app's process, so
 * it uses only what the table gives it.
 */
#ifndef VIBE_PLUGIN_H
#define VIBE_PLUGIN_H

#define VIBE_NATIVE_ABI 1

typedef struct vibe_host {
  int abi;                                 /* VIBE_NATIVE_ABI */
  void *(*app_overlay)(void);              /* the app window's GtkOverlay (a GtkWidget *) */
  void (*app_eval)(const char *script);    /* runs a script in the app window's page */
} vibe_host;

/* Called once, before anything else. Returns 0 on success. */
int vibe_plugin_init(const vibe_host *host);
/* Creates the panel's widget (hidden) and records the command to run in it; NULL-terminated argv, an empty
   command runs the user's shell. A second call keeps the first panel. Returns 0 on success. */
int vibe_panel_open(char **argv);
/* Places the panel over the window at (x, y) with the size, in CSS pixels; hidden when not visible. */
void vibe_panel_frame(double x, double y, double width, double height, int visible);

#endif
