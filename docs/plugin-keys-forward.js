// Put this in a plugin's page (a <script> in its HTML, served by its sidecar) so the app's own keys work
// while the page has the focus. The page is a frame on another origin: keys pressed in it never reach the
// app otherwise. Keys not listed here stay in the page.
(function () {
  var APP_KEYS = ['F11', 'ArrowLeft', 'ArrowRight', 'r', 'R'];
  window.addEventListener('keydown', function (e) {
    var app = e.key === 'F11' || (e.ctrlKey && e.shiftKey && !e.altKey && APP_KEYS.indexOf(e.key) >= 0);
    if (!app) return;
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage({ vibeKey: { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } }, '*');
  }, true);
})();
