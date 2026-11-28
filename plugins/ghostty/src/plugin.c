// The app's native terminal pane: a GTK widget on the app window's overlay, above the page. It draws the screen
// that termcore.zig keeps (libghostty-vt on a PTY) and sends keys and wheel input back to it. The keys the app
// itself uses (F11, Ctrl+Shift+arrows and R) are passed to the page, since the terminal has the focus.

#include <gtk/gtk.h>
#include <glib-unix.h>
#include <pango/pangocairo.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "vibe_plugin.h"
#include <math.h>

// The app's table (vibe_plugin.h): the overlay the panel sits on, and running script in the page.
static const vibe_host *host = NULL;
static void *app_overlay(void) { return host ? host->app_overlay() : NULL; }
static void app_eval(const char *script) { if (host) host->app_eval(script); }

// Provided by termcore.zig.
typedef struct {
  uint32_t cp;
  uint8_t fg[3], bg[3];
  uint8_t flags; // 1 bold, 2 italic, 4 underline, 8 inverse, 16 strikethrough, 32 faint
  uint8_t wide;  // 0 narrow, 1 wide, 2 spacer tail
} TcCell;

typedef struct {
  uint16_t cols, rows;
  TcCell *cells;
  uint8_t fg[3], bg[3];
  uint8_t cursor_visible;
  uint16_t cursor_x, cursor_y;
} TcFrame;

int tc_start(uint16_t cols, uint16_t rows, char **argv);
int tc_fd(void);
int tc_pump(void);
int tc_exited(void);
void tc_write(const uint8_t *data, size_t len);
void tc_resize(uint16_t cols, uint16_t rows);
void tc_scroll(int32_t delta);
int tc_mouse_tracking(void);
void tc_snapshot(TcFrame *out);

int vibe_plugin_init(const vibe_host *h) {
  if (!h || h->abi != VIBE_NATIVE_ABI) return -1;
  host = h;
  return 0;
}

static GtkWidget *area = NULL;
static GtkWidget *overlay = NULL;
// one text context for measuring and drawing: its font options are set here (grayscale antialiasing, slight
// hinting), as Ghostty's own text rendering uses, instead of whatever the cairo surface defaults to
static PangoContext *text_ctx = NULL;
static char **child_argv = NULL; // the command, copied; NULL-terminated
static PangoFontDescription *fonts[4]; // regular, bold, italic, bold italic
static double cell_w = 10, cell_h = 20;
static double wheel_acc = 0;
static double ptr_x = 0, ptr_y = 0;
static GtkIMContext *im = NULL;
static char preedit[256] = ""; // the text being composed (input method), drawn at the cursor
static int started = 0; // the child was asked to start
static int running = 0; // the terminal exists (the child started), so frames can be drawn
static int exited = 0;

static void measure_cells(void) {
  PangoContext *ctx = text_ctx;
  PangoLayout *l = pango_layout_new(ctx);
  pango_layout_set_font_description(l, fonts[0]);
  pango_layout_set_text(l, "M", -1);
  gint w = 0, h = 0;
  pango_layout_get_size(l, &w, &h);
  // whole pixels for the cells, as Ghostty does: a fractional cell (9.6 px) makes runs of text that start in
  // different places land on different columns when a selection splits them. Glyphs are placed on whole pixels too.
  cell_w = round((double)w / PANGO_SCALE);
  cell_h = ceil((double)h / PANGO_SCALE);
  g_object_unref(l);
}

static void make_text_context(void) {
  text_ctx = pango_font_map_create_context(pango_cairo_font_map_get_default());
  cairo_font_options_t *options = cairo_font_options_create();
  cairo_font_options_set_antialias(options, CAIRO_ANTIALIAS_GRAY);
  cairo_font_options_set_hint_style(options, CAIRO_HINT_STYLE_SLIGHT);
  cairo_font_options_set_hint_metrics(options, CAIRO_HINT_METRICS_OFF);
  pango_cairo_context_set_font_options(text_ctx, options);
  cairo_font_options_destroy(options);
}

static void set_color(cairo_t *cr, const uint8_t c[3], double alpha) {
  cairo_set_source_rgba(cr, c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, alpha);
}

static gboolean same_style(const TcCell *a, const TcCell *b) {
  return a->fg[0] == b->fg[0] && a->fg[1] == b->fg[1] && a->fg[2] == b->fg[2] &&
         a->bg[0] == b->bg[0] && a->bg[1] == b->bg[1] && a->bg[2] == b->bg[2] &&
         a->flags == b->flags;
}

static void cell_colors(const TcCell *c, uint8_t fg[3], uint8_t bg[3]) {
  if (c->flags & 8) {
    memcpy(fg, c->bg, 3);
    memcpy(bg, c->fg, 3);
  } else {
    memcpy(fg, c->fg, 3);
    memcpy(bg, c->bg, 3);
  }
}

static gboolean on_pty(gint fd, GIOCondition cond, gpointer data);

/* ---- input method (IME): Vietnamese typing and other composed input ---- */

// text that is final (a composed word, or a plain key the input method passes on): it goes to the program
static void on_commit(GtkIMContext *c, const char *text, gpointer data) {
  (void)c;
  (void)data;
  if (text && *text) tc_write((const uint8_t *)text, strlen(text));
}

static void on_preedit_changed(GtkIMContext *c, gpointer data) {
  (void)data;
  char *text = NULL;
  PangoAttrList *attrs = NULL;
  gtk_im_context_get_preedit_string(c, &text, &attrs, NULL);
  snprintf(preedit, sizeof preedit, "%s", text ? text : "");
  g_free(text);
  if (attrs) pango_attr_list_unref(attrs);
  if (area) gtk_widget_queue_draw(area);
}

static void on_preedit_end(GtkIMContext *c, gpointer data) {
  (void)c;
  (void)data;
  preedit[0] = 0;
  if (area) gtk_widget_queue_draw(area);
}

static void on_focus_enter(GtkEventControllerFocus *f, gpointer data) {
  (void)f;
  (void)data;
  if (im) gtk_im_context_focus_in(im);
}

static void on_focus_leave(GtkEventControllerFocus *f, gpointer data) {
  (void)f;
  (void)data;
  if (im) gtk_im_context_focus_out(im);
}

// Box-drawing lines (U+2500..U+253C, light weight) are drawn as geometry, not from the font, as Ghostty does:
// each line runs from the cell's middle to its edges, so neighbouring cells join into one unbroken line.
// Returns 0 for any other character.
static int draw_box(cairo_t *cr, uint32_t cp, double x, double y, double w, double h) {
  int left = 0, right = 0, up = 0, down = 0;
  switch (cp) {
    case 0x2500: left = right = 1; break;               // ─
    case 0x2502: up = down = 1; break;                  // │
    case 0x250C: right = down = 1; break;               // ┌
    case 0x2510: left = down = 1; break;                // ┐
    case 0x2514: right = up = 1; break;                 // └
    case 0x2518: left = up = 1; break;                  // ┘
    case 0x251C: up = down = right = 1; break;          // ├
    case 0x2524: up = down = left = 1; break;           // ┤
    case 0x252C: left = right = down = 1; break;        // ┬
    case 0x2534: left = right = up = 1; break;          // ┴
    case 0x253C: left = right = up = down = 1; break;   // ┼
    default: return 0;
  }
  double mx = floor(x + w / 2) + 0.5, my = floor(y + h / 2) + 0.5;
  cairo_set_line_width(cr, 1.0);
  if (left) { cairo_move_to(cr, x, my); cairo_line_to(cr, mx, my); }
  if (right) { cairo_move_to(cr, mx, my); cairo_line_to(cr, x + w, my); }
  if (up) { cairo_move_to(cr, mx, y); cairo_line_to(cr, mx, my); }
  if (down) { cairo_move_to(cr, mx, my); cairo_line_to(cr, mx, y + h); }
  cairo_stroke(cr);
  return 1;
}

static void draw_cb(GtkDrawingArea *da, cairo_t *cr, int width, int height, gpointer data) {
  (void)da;
  (void)data;
  if (!running) return;
  uint16_t cols = (uint16_t)(width / cell_w);
  uint16_t rows = (uint16_t)(height / cell_h);
  if (cols < 2) cols = 2;
  if (rows < 1) rows = 1;
  tc_resize(cols, rows);

  TcFrame f;
  tc_snapshot(&f);

  set_color(cr, f.bg, 1.0);
  cairo_paint(cr);

  PangoLayout *layout = pango_layout_new(text_ctx);
  static char text[6 * 1024];

  for (int y = 0; y < f.rows; y++) {
    TcCell *row = f.cells + (size_t)y * f.cols;
    double base_y = y * cell_h;
    int x = 0;
    while (x < f.cols) {
      TcCell *first = &row[x];
      if (first->wide == 2) { // spacer tail: drawn with its head
        x++;
        continue;
      }
      uint8_t fg[3], bg[3];
      cell_colors(first, fg, bg);
      // a run: same colors and attributes, narrow cells only; a wide cell is a run of its own
      int end = x + 1;
      int is_box = first->wide == 0 && first->cp >= 0x2500 && first->cp <= 0x253C && first->cp != 0x2503;
      if (is_box) {
        // a line character is a run of its own
      } else if (first->wide == 0) {
        while (end < f.cols && row[end].wide == 0 && same_style(first, &row[end])) end++;
      } else {
        end = x + 2;
      }
      if (end > f.cols) end = f.cols;
      int run_cols = end - x;
      if (memcmp(bg, f.bg, 3) != 0 || (first->flags & 8)) {
        // edges on whole pixels: neighbouring runs meet without a gap
        double x0 = round(x * cell_w), x1 = round(end * cell_w);
        set_color(cr, bg, 1.0);
        cairo_rectangle(cr, x0, base_y, x1 - x0, cell_h);
        cairo_fill(cr);
      }
      size_t n = 0;
      for (int i = x; i < end; i++) {
        uint32_t cp = row[i].cp ? row[i].cp : ' ';
        n += g_unichar_to_utf8((gunichar)cp, text + n);
      }
      text[n] = 0;
      int font = ((first->flags & 1) ? 1 : 0) | ((first->flags & 2) ? 2 : 0);
      pango_layout_set_font_description(layout, fonts[font]);
      pango_layout_set_text(layout, text, (int)n);
      set_color(cr, fg, (first->flags & 32) ? 0.5 : 1.0);
      if (is_box && draw_box(cr, first->cp, x * cell_w, base_y, cell_w, cell_h)) {
        x = end;
        continue;
      }
      int pixel_w = 0;
      pango_layout_get_pixel_size(layout, &pixel_w, NULL);
      if (first->wide == 0 && pixel_w != run_cols * (int)cell_w) {
        // a glyph from another font (a bullet, a symbol) has its own advance, and would push the rest of the run
        // off the grid: each cell is then drawn on its own column
        for (int i = x; i < end; i++) {
          char one[8];
          size_t m = g_unichar_to_utf8(row[i].cp ? row[i].cp : ' ', one);
          one[m] = 0;
          pango_layout_set_text(layout, one, (int)m);
          cairo_move_to(cr, i * cell_w, base_y);
          pango_cairo_show_layout(cr, layout);
        }
      } else {
        cairo_move_to(cr, x * cell_w, base_y);
        pango_cairo_show_layout(cr, layout);
      }
      if (first->flags & 4) { // underline
        cairo_rectangle(cr, x * cell_w, base_y + cell_h - 1, run_cols * cell_w, 1);
        cairo_fill(cr);
      }
      if (first->flags & 16) { // strikethrough
        cairo_rectangle(cr, x * cell_w, base_y + cell_h / 2, run_cols * cell_w, 1);
        cairo_fill(cr);
      }
      x = end;
    }
  }

  if (f.cursor_visible) {
    // a solid block in the text color (as Ghostty draws it), with the character under it in the background color
    set_color(cr, f.fg, 1.0);
    cairo_rectangle(cr, f.cursor_x * cell_w, f.cursor_y * cell_h, cell_w, cell_h);
    cairo_fill(cr);
    const TcCell *under = &f.cells[(size_t)f.cursor_y * f.cols + f.cursor_x];
    if (under->cp > ' ' && under->wide != 2) {
      char glyph[8];
      size_t gn = g_unichar_to_utf8((gunichar)under->cp, glyph);
      glyph[gn] = 0;
      int font = ((under->flags & 1) ? 1 : 0) | ((under->flags & 2) ? 2 : 0);
      pango_layout_set_font_description(layout, fonts[font]);
      pango_layout_set_text(layout, glyph, (int)gn);
      set_color(cr, f.bg, 1.0);
      cairo_move_to(cr, f.cursor_x * cell_w, f.cursor_y * cell_h);
      pango_cairo_show_layout(cr, layout);
    }
    // the composed text sits on the cursor, over the cells it covers, with an underline
    if (preedit[0]) {
      size_t n = strlen(preedit);
      double px = f.cursor_x * cell_w, py = f.cursor_y * cell_h;
      pango_layout_set_font_description(layout, fonts[0]);
      pango_layout_set_text(layout, preedit, (int)n);
      int pw = 0, ph = 0;
      pango_layout_get_pixel_size(layout, &pw, &ph);
      set_color(cr, f.bg, 1.0);
      cairo_rectangle(cr, px, py, pw, cell_h);
      cairo_fill(cr);
      set_color(cr, f.fg, 1.0);
      cairo_move_to(cr, px, py);
      pango_cairo_show_layout(cr, layout);
      cairo_rectangle(cr, px, py + cell_h - 1, pw, 1);
      cairo_fill(cr);
    }
    if (im) {
      GdkRectangle where = {(int)(f.cursor_x * cell_w), (int)(f.cursor_y * cell_h), (int)cell_w, (int)cell_h};
      gtk_im_context_set_cursor_location(im, &where);
    }
  }
  g_object_unref(layout);
}

// ---- the child process

static gboolean on_pty(gint fd, GIOCondition cond, gpointer data) {
  (void)fd;
  (void)cond;
  (void)data;
  if (!area) return G_SOURCE_REMOVE;
  int r = tc_pump();
  if (r < 0 || tc_exited()) {
    exited = 1;
    if (area) gtk_widget_queue_draw(area);
    return G_SOURCE_REMOVE;
  }
  if (r > 0) gtk_widget_queue_draw(area);
  return G_SOURCE_CONTINUE;
}

// ---- input

// Keys the app uses, which the terminal must not take: they are dispatched to the page as key events.
static int is_app_key(guint keyval, GdkModifierType state) {
  if (keyval == GDK_KEY_F11) return 1;
  const GdkModifierType need = GDK_CONTROL_MASK | GDK_SHIFT_MASK;
  if ((state & need) != need || (state & GDK_ALT_MASK)) return 0;
  return keyval == GDK_KEY_Left || keyval == GDK_KEY_Right || keyval == GDK_KEY_r || keyval == GDK_KEY_R;
}

static void pass_to_app(guint keyval, GdkModifierType state) {
  const char *key = NULL;
  const char *code = NULL;
  char letter[2] = {0, 0};
  if (keyval == GDK_KEY_F11) { key = "F11"; code = "F11"; }
  else if (keyval == GDK_KEY_Left) { key = "ArrowLeft"; code = "ArrowLeft"; }
  else if (keyval == GDK_KEY_Right) { key = "ArrowRight"; code = "ArrowRight"; }
  else {
    letter[0] = (keyval == GDK_KEY_R) ? 'R' : 'r';
    key = letter;
    code = "KeyR";
  }
  char script[512];
  snprintf(script, sizeof script,
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'%s',code:'%s',ctrlKey:%s,shiftKey:%s,altKey:false,metaKey:false,bubbles:true,cancelable:true}));",
    key, code, (state & GDK_CONTROL_MASK) ? "true" : "false", (state & GDK_SHIFT_MASK) ? "true" : "false");
  app_eval(script);
}

static void send(const char *bytes, size_t n) { tc_write((const uint8_t *)bytes, n); }

static gboolean on_key(GtkEventControllerKey *k, guint keyval, guint keycode, GdkModifierType state, gpointer data) {
  (void)k;
  (void)keycode;
  (void)data;
  if (is_app_key(keyval, state)) {
    pass_to_app(keyval, state);
    return TRUE;
  }
  // word moves: Ctrl+arrows as xterm sends them, Alt+arrows as ESC b / ESC f (what readline and zsh read for a word)
  if ((keyval == GDK_KEY_Left || keyval == GDK_KEY_Right) && (state & (GDK_CONTROL_MASK | GDK_ALT_MASK)) && !(state & GDK_SHIFT_MASK)) {
    const int left = keyval == GDK_KEY_Left;
    if (state & GDK_CONTROL_MASK) {
      char seq[16];
      snprintf(seq, sizeof seq, "\x1b[1;5%s", left ? "D" : "C");
      send(seq, strlen(seq));
    } else {
      const char *word = left ? "\x1b" "b" : "\x1b" "f"; // ESC b / ESC f
      send(word, 2);
    }
    return TRUE;
  }
  const char *seq = NULL;
  switch (keyval) {
    case GDK_KEY_Return:
    case GDK_KEY_KP_Enter: seq = "\r"; break;
    case GDK_KEY_BackSpace: seq = "\x7f"; break;
    case GDK_KEY_Tab: seq = "\t"; break;
    case GDK_KEY_ISO_Left_Tab: seq = "\x1b[Z"; break;
    case GDK_KEY_Escape: seq = "\x1b"; break;
    case GDK_KEY_Up: seq = "\x1b[A"; break;
    case GDK_KEY_Down: seq = "\x1b[B"; break;
    case GDK_KEY_Right: seq = "\x1b[C"; break;
    case GDK_KEY_Left: seq = "\x1b[D"; break;
    case GDK_KEY_Home: seq = "\x1b[H"; break;
    case GDK_KEY_End: seq = "\x1b[F"; break;
    case GDK_KEY_Page_Up: seq = "\x1b[5~"; break;
    case GDK_KEY_Page_Down: seq = "\x1b[6~"; break;
    case GDK_KEY_Insert: seq = "\x1b[2~"; break;
    case GDK_KEY_Delete: seq = "\x1b[3~"; break;
    default: break;
  }
  if (seq) {
    // Alt before a special key is ESC in front of it: Alt+Backspace is ESC DEL (delete the word, in readline)
    if (state & GDK_ALT_MASK) send("\x1b", 1);
    send(seq, strlen(seq));
    return TRUE;
  }
  gunichar u = gdk_keyval_to_unicode(keyval);
  if (!u) return FALSE;
  char out[8];
  size_t n = 0;
  if ((state & GDK_CONTROL_MASK) && u < 128) {
    if (u >= 'a' && u <= 'z') u = u - 'a' + 1;
    else if (u >= 'A' && u <= 'Z') u = u - 'A' + 1;
    else if (u == ' ' || u == '@') u = 0;
    else if (u >= '[' && u <= '_') u = u - '@';
    else return FALSE;
    out[n++] = (char)u;
  } else {
    n = g_unichar_to_utf8(u, out);
  }
  if (state & GDK_ALT_MASK) {
    char alt[10];
    alt[0] = '\x1b';
    memcpy(alt + 1, out, n);
    send(alt, n + 1);
  } else {
    send(out, n);
  }
  return TRUE;
}

static void send_wheel(int button, int count) {
  // a wheel report goes to the cell under the pointer (SGR mouse protocol, 1-based)
  int col = (int)(ptr_x / cell_w) + 1;
  int row = (int)(ptr_y / cell_h) + 1;
  char report[32];
  int n = snprintf(report, sizeof report, "\x1b[<%d;%d;%dM", button, col, row);
  for (int i = 0; i < count; i++) send(report, (size_t)n);
}

static gboolean on_scroll(GtkEventControllerScroll *c, gdouble dx, gdouble dy, gpointer data) {
  (void)c;
  (void)dx;
  (void)data;
  wheel_acc += dy; // GTK: one notch is 1.0; touchpads send fractions
  int lines = (int)wheel_acc; // truncates toward zero
  if (lines == 0) return TRUE;
  wheel_acc -= lines;
  if (tc_mouse_tracking()) {
    int count = lines < 0 ? -lines : lines;
    if (count > 50) count = 50;
    send_wheel(lines < 0 ? 64 : 65, count);
  } else {
    tc_scroll(lines);
  }
  gtk_widget_queue_draw(area);
  return TRUE;
}

// Mouse reports (SGR) to a program that asked for the mouse: its clicks and drags, e.g. herdr's buttons.
// Without it the clicks only take the focus.
static int pressed_code = -1; // the SGR button held down, or -1

static int sgr_button(guint button) {
  switch (button) {
    case 1: return 0; // left
    case 2: return 1; // middle
    case 3: return 2; // right
    default: return -1;
  }
}

static int modifier_bits(GdkModifierType state) {
  return ((state & GDK_SHIFT_MASK) ? 4 : 0) | ((state & GDK_ALT_MASK) ? 8 : 0) | ((state & GDK_CONTROL_MASK) ? 16 : 0);
}

// one report at a pixel position: button code (+ modifiers), press (M) or release (m)
static void send_mouse(int code, int release, GdkModifierType state, double x, double y) {
  int col = (int)(x / cell_w) + 1;
  int row = (int)(y / cell_h) + 1;
  char report[48];
  int n = snprintf(report, sizeof report, "\x1b[<%d;%d;%d%c", code | modifier_bits(state), col, row, release ? 'm' : 'M');
  send(report, (size_t)n);
}

static void on_pressed(GtkGestureClick *g, int n, double x, double y, gpointer data) {
  (void)n;
  (void)data;
  gtk_widget_grab_focus(area);
  ptr_x = x;
  ptr_y = y;
  int code = sgr_button(gtk_gesture_single_get_current_button(GTK_GESTURE_SINGLE(g)));
  if (code < 0 || !tc_mouse_tracking()) return;
  pressed_code = code;
  send_mouse(code, 0, gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(g)), x, y);
}

static void on_released(GtkGestureClick *g, int n, double x, double y, gpointer data) {
  (void)n;
  (void)data;
  if (pressed_code < 0) return;
  send_mouse(pressed_code, 1, gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(g)), x, y);
  pressed_code = -1;
}

static void on_motion(GtkEventControllerMotion *m, gdouble x, gdouble y, gpointer data) {
  (void)data;
  ptr_x = x;
  ptr_y = y;
  // a drag: the button held down is reported with the motion (+32)
  if (pressed_code >= 0 && tc_mouse_tracking()) send_mouse(pressed_code + 32, 0, gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(m)), x, y);
}

/* ---- the API the app calls (termpane.zig) ---- */

int vibe_panel_open(char **argv) {
  if (area) return 0;
  overlay = app_overlay();
  if (!overlay) return -1;
  // no command (the plugin's default): the user's shell
  char *shell_argv[2] = {NULL, NULL};
  if (!argv || !argv[0]) {
    const char *shell = getenv("SHELL");
    shell_argv[0] = (char *)(shell && *shell ? shell : "/bin/sh");
    argv = shell_argv;
  }
  int n = 0;
  while (argv[n]) n++;
  child_argv = calloc((size_t)n + 1, sizeof(char *));
  if (!child_argv) return -1;
  for (int i = 0; i < n; i++) child_argv[i] = strdup(argv[i]);

  const char *families[4] = {"IBM Plex Mono 12", "IBM Plex Mono Bold 12", "IBM Plex Mono Italic 12", "IBM Plex Mono Bold Italic 12"};
  for (int i = 0; i < 4; i++) fonts[i] = pango_font_description_from_string(families[i]);

  area = gtk_drawing_area_new();
  gtk_widget_set_focusable(area, TRUE);
  gtk_widget_set_halign(area, GTK_ALIGN_START);
  gtk_widget_set_valign(area, GTK_ALIGN_START);
  gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(area), draw_cb, NULL, NULL);
  make_text_context();
  measure_cells();

  // the input method sees the keys first: what it composes comes back as "commit", the rest as key presses
  im = gtk_im_multicontext_new();
  gtk_im_context_set_client_widget(im, area);
  g_signal_connect(im, "commit", G_CALLBACK(on_commit), NULL);
  g_signal_connect(im, "preedit-changed", G_CALLBACK(on_preedit_changed), NULL);
  g_signal_connect(im, "preedit-end", G_CALLBACK(on_preedit_end), NULL);

  GtkEventController *key = gtk_event_controller_key_new();
  gtk_event_controller_key_set_im_context(GTK_EVENT_CONTROLLER_KEY(key), im);
  g_signal_connect(key, "key-pressed", G_CALLBACK(on_key), NULL);
  gtk_widget_add_controller(area, key);

  GtkEventController *focus = gtk_event_controller_focus_new();
  g_signal_connect(focus, "enter", G_CALLBACK(on_focus_enter), NULL);
  g_signal_connect(focus, "leave", G_CALLBACK(on_focus_leave), NULL);
  gtk_widget_add_controller(area, focus);

  GtkEventController *scroll = gtk_event_controller_scroll_new(GTK_EVENT_CONTROLLER_SCROLL_VERTICAL);
  g_signal_connect(scroll, "scroll", G_CALLBACK(on_scroll), NULL);
  gtk_widget_add_controller(area, scroll);

  GtkEventController *motion = gtk_event_controller_motion_new();
  g_signal_connect(motion, "motion", G_CALLBACK(on_motion), NULL);
  gtk_widget_add_controller(area, motion);

  GtkGesture *click = gtk_gesture_click_new();
  gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(click), 0); // every button, not only the primary one
  g_signal_connect(click, "pressed", G_CALLBACK(on_pressed), NULL);
  g_signal_connect(click, "released", G_CALLBACK(on_released), NULL);
  gtk_widget_add_controller(area, GTK_EVENT_CONTROLLER(click));

  gtk_widget_set_visible(area, FALSE);
  gtk_overlay_add_overlay(GTK_OVERLAY(overlay), area);
  return 0;
}

/* The child starts with the first non-empty frame. */
void vibe_panel_frame(double x, double y, double w, double h, int visible) {
  if (!area) return;
  // a negative position (the pane is partly off the window) cannot be placed: it is hidden instead
  if (!visible || w < 1 || h < 1 || x < 0 || y < 0) {
    gtk_widget_set_visible(area, FALSE);
    return;
  }
  gtk_widget_set_margin_start(area, (int)x);
  gtk_widget_set_margin_top(area, (int)y);
  gtk_widget_set_size_request(area, (int)w, (int)h);
  gtk_widget_set_visible(area, TRUE);
  if (!started) {
    started = 1;
    uint16_t cols = (uint16_t)(w / cell_w);
    uint16_t rows = (uint16_t)(h / cell_h);
    if (cols < 2) cols = 2;
    if (rows < 1) rows = 1;
    if (tc_start(cols, rows, child_argv) != 0) {
      fprintf(stderr, "terminal: could not start %s\n", child_argv[0]);
      exited = 1;
      gtk_widget_set_visible(area, FALSE);
      return;
    }
    running = 1;
    g_unix_fd_add(tc_fd(), G_IO_IN | G_IO_HUP | G_IO_ERR, on_pty, NULL);
  }
  gtk_widget_grab_focus(area);
}
