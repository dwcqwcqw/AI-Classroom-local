import { injectIntoDocumentHead } from './html-document';

/**
 * In-memory localStorage/sessionStorage shim, injected as the FIRST thing in the
 * document so the page's own scripts see working storage.
 *
 * The interactive iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
 * (intentional — combining them negates the sandbox for LLM-authored HTML). In a
 * null-origin document, touching `window.localStorage` throws a SecurityError;
 * many generated pages read/write storage in their setup code, so that throw
 * crashes the script before anything renders → a blank/black widget. This shim
 * replaces both storages with an in-memory implementation when the real ones are
 * inaccessible, keeping the sandbox intact while letting storage-using pages run.
 */
const STORAGE_SHIM = `<script data-iframe-storage-shim>
(function () {
  function makeStore() {
    var data = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var s = window[name]; if (s) { s.getItem('__probe__'); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch (e) {}
    }
  });
})();
</script>`;

/**
 * Runtime-error capture, injected as the VERY FIRST script so it observes errors
 * from the storage shim and every page script that follows. Generated interactive
 * pages frequently die on a runtime error (a `JSON.parse` of malformed config, a
 * reference to a CDN lib that failed to load, …) → the script aborts and the
 * widget renders blank. The sandboxed (null-origin) iframe can't be read by the
 * editor, but it CAN `postMessage` out: this forwards `window.onerror`, unhandled
 * rejections and `console.error` to the parent, which stores them per scene and
 * feeds them to the editor agent — so it can diagnose a blank page instead of
 * guessing. Only touches `window.*` so it stays sandbox-safe and unit-testable.
 *
 * The most important errors (a `JSON.parse` that aborts setup) fire SYNCHRONOUSLY
 * while srcDoc parses — potentially before the parent has subscribed its `message`
 * listener (which it installs from a passive effect after inserting the iframe).
 * To avoid losing exactly the errors this feature exists to surface, every post is
 * also buffered, and the shim re-emits the whole buffer when the parent sends a
 * `{ __maicErrorReplayRequest: true }` message once its listener is ready. The
 * parent dedups, so the live + replayed copies collapse to one.
 */
const ERROR_CAPTURE_SHIM = `<script data-iframe-error-shim>
(function () {
  var buffer = [];
  function emit(errorKind, message) {
    try {
      window.parent.postMessage(
        { __maicInteractive: true, kind: 'runtime-error', errorKind: errorKind, message: message },
        '*'
      );
    } catch (e) {}
  }
  function post(errorKind, message) {
    message = String(message).slice(0, 1200);
    if (buffer.length < 50) buffer.push([errorKind, message]);
    emit(errorKind, message);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.__maicErrorReplayRequest === true) {
      for (var i = 0; i < buffer.length; i++) emit(buffer[i][0], buffer[i][1]);
    }
  });
  window.addEventListener('error', function (e) {
    if (e && e.message) {
      post('error', e.message + (e.filename ? ' (' + e.filename + ':' + (e.lineno || 0) + ')' : ''));
    } else if (e && e.target && (e.target.src || e.target.href)) {
      post('resource', 'Failed to load resource: ' + (e.target.src || e.target.href));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post('unhandledrejection', (r && (r.stack || r.message)) || r || 'unhandled promise rejection');
  });
  try {
    var c = window.console;
    if (c && c.error) {
      var _ce = c.error;
      c.error = function () {
        try { post('console.error', Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(' ')); } catch (e) {}
        return _ce.apply(c, arguments);
      };
    }
  } catch (e) {}
})();
</script>`;

/**
 * Keep the primary simulation actions reachable on narrow touch screens.
 *
 * Interactive pages are model-authored documents, including older courses that
 * cannot be regenerated just to pick up a CSS fix. A frequent mobile failure is
 * that the responsive layout hides the sidebar containing Start / Pause / Reset,
 * or places it after a very tall canvas. Moving the ORIGINAL button nodes into a
 * small mobile action dock preserves their event listeners and inline handlers.
 * On wider viewports the buttons are restored to their exact authored position.
 */
const MOBILE_ACTIONS_SHIM = `<style data-iframe-mobile-actions>
  #maic-mobile-action-dock {
    display: none;
  }

  @media (max-width: 768px) {
    html {
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }

    body.maic-mobile-actions-visible {
      padding-bottom: calc(76px + env(safe-area-inset-bottom, 0px)) !important;
    }

    #maic-mobile-action-dock {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 2147483000;
      display: flex;
      gap: 10px;
      align-items: stretch;
      padding: 10px max(12px, env(safe-area-inset-right, 0px))
        calc(10px + env(safe-area-inset-bottom, 0px))
        max(12px, env(safe-area-inset-left, 0px));
      background: rgba(8, 17, 31, 0.94);
      border-top: 1px solid rgba(148, 163, 184, 0.34);
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    #maic-mobile-action-dock > button,
    #maic-mobile-action-dock > input[type="button"],
    #maic-mobile-action-dock > input[type="reset"] {
      display: inline-flex !important;
      flex: 1 1 0 !important;
      align-items: center !important;
      justify-content: center !important;
      width: auto !important;
      min-width: 0 !important;
      min-height: 48px !important;
      margin: 0 !important;
      padding: 10px 16px !important;
      font-size: 16px !important;
      line-height: 1.2 !important;
      visibility: visible !important;
      opacity: 1 !important;
      touch-action: manipulation;
      cursor: pointer;
    }
  }
</style>
<script data-iframe-mobile-actions-shim>
(function () {
  var dockId = 'maic-mobile-action-dock';
  var records = [];
  var syncing = false;
  var actionWords = /(?:^|[^a-z])(start|run|play|pause|resume|reset|restart|simulate|launch)(?:[^a-z]|$)|启动|开始|运行|播放|暂停|继续|重置|复位|重新开始/i;

  function isMobile() {
    return window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : window.innerWidth <= 768;
  }

  function signature(node) {
    return [
      node.id,
      node.getAttribute('name'),
      node.getAttribute('data-action'),
      node.getAttribute('aria-label'),
      node.getAttribute('title'),
      node.textContent,
      node.value
    ].filter(Boolean).join(' ');
  }

  function isPrimaryAction(node) {
    if (!node || node.id === dockId || node.closest('#' + dockId)) return false;
    if (node.hasAttribute('data-maic-mobile-ignore')) return false;
    var type = String(node.getAttribute('type') || '').toLowerCase();
    if (node.tagName === 'INPUT' && type !== 'button' && type !== 'reset') return false;
    return actionWords.test(signature(node));
  }

  function getDock() {
    var dock = document.getElementById(dockId);
    if (!dock) {
      dock = document.createElement('div');
      dock.id = dockId;
      dock.setAttribute('role', 'toolbar');
      dock.setAttribute('aria-label', '互动操作');
      document.body.appendChild(dock);
    }
    return dock;
  }

  function moveActionsIntoDock() {
    var candidates = Array.prototype.filter.call(
      document.querySelectorAll('button, input[type="button"], input[type="reset"]'),
      isPrimaryAction
    ).slice(0, 4);
    if (!candidates.length && !records.length) return;

    var dock = getDock();
    candidates.forEach(function (node) {
      var exists = records.some(function (record) { return record.node === node; });
      if (exists) return;
      var marker = document.createComment('maic-mobile-action-origin');
      node.parentNode.insertBefore(marker, node);
      records.push({ node: node, marker: marker, style: node.getAttribute('style') });
      dock.appendChild(node);
    });

    if (records.length) document.body.classList.add('maic-mobile-actions-visible');
  }

  function restoreActions() {
    records.forEach(function (record) {
      if (record.marker.parentNode) record.marker.parentNode.insertBefore(record.node, record.marker);
      record.marker.remove();
      if (record.style === null) record.node.removeAttribute('style');
      else record.node.setAttribute('style', record.style);
    });
    records = [];
    document.body.classList.remove('maic-mobile-actions-visible');
    var dock = document.getElementById(dockId);
    if (dock) dock.remove();
  }

  function sync() {
    if (syncing || !document.body) return;
    syncing = true;
    try {
      if (isMobile()) moveActionsIntoDock();
      else restoreActions();
    } finally {
      syncing = false;
    }
  }

  function init() {
    sync();
    window.addEventListener('resize', sync, { passive: true });
    if (window.MutationObserver) {
      var observer = new MutationObserver(function () { if (!syncing) sync(); });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>`;

/**
 * Generated interactive pages commonly reference KaTeX through jsDelivr or
 * unpkg. Those hosts add another cross-border dependency for mainland viewers.
 * The build ships the same pinned npm runtime under our own origin, so existing
 * classrooms can become self-contained without being regenerated.
 */
function rewriteKnownRuntimeUrls(html: string): string {
  const katexPackage = String.raw`(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/katex@[^/"'\s]+\/dist`;
  return html
    .replace(
      new RegExp(String.raw`(?:https?:)?\/\/${katexPackage}\/katex(?:\.min)?\.css`, 'gi'),
      '/vendor/katex/katex.min.css',
    )
    .replace(
      new RegExp(String.raw`(?:https?:)?\/\/${katexPackage}\/katex(?:\.min)?\.js`, 'gi'),
      '/vendor/katex/katex.min.js',
    )
    .replace(
      new RegExp(
        String.raw`(?:https?:)?\/\/${katexPackage}\/contrib\/auto-render(?:\.min)?\.js`,
        'gi',
      ),
      '/vendor/katex/auto-render.min.js',
    );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects a runtime-error capture shim + a storage shim (so sandboxed pages that
 * use localStorage don't crash) plus CSS that ensures proper sizing and scrolling
 * behavior when HTML content is rendered via srcDoc in an iframe. The shims are
 * placed first so they run before the page's own scripts (error capture first, so
 * it also observes the storage shim).
 */
export function patchHtmlForIframe(html: string): string {
  const selfHostedHtml = rewriteKnownRuntimeUrls(html);
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  const viewportMeta = /<meta\s+[^>]*name=["']viewport["']/i.test(selfHostedHtml)
    ? ''
    : '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
  const injection =
    '\n' +
    viewportMeta +
    ERROR_CAPTURE_SHIM +
    '\n' +
    STORAGE_SHIM +
    '\n' +
    iframeCss +
    '\n' +
    MOBILE_ACTIONS_SHIM;

  return injectIntoDocumentHead(selfHostedHtml, injection);
}
