// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

describe('patchHtmlForIframe', () => {
  it('injects the storage shim and sizing CSS after <head>', () => {
    const out = patchHtmlForIframe(
      '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>',
    );
    expect(out).toContain('data-iframe-storage-shim');
    expect(out).toContain('data-iframe-patch');
    expect(out).toContain('data-iframe-mobile-actions-shim');
  });

  it('injects a mobile viewport and a reachable touch action dock', () => {
    const out = patchHtmlForIframe(`
      <html><head></head><body>
        <aside style="display:none"><button id="start-btn">启动</button></aside>
        <button id="reset-btn">重置</button>
      </body></html>
    `);

    expect(out).toContain('name="viewport"');
    expect(out).toContain('viewport-fit=cover');
    expect(out).toContain('maic-mobile-action-dock');
    expect(out).toContain('node.parentNode.insertBefore(marker, node)');
    expect(out).toContain('min-height: 48px !important');
    expect(out).toContain('env(safe-area-inset-bottom, 0px)');
  });

  it('does not inject a duplicate viewport meta tag', () => {
    const out = patchHtmlForIframe(
      '<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>',
    );
    expect(out.match(/name="viewport"/g)).toHaveLength(1);
  });

  it('rewrites common KaTeX CDN dependencies to the self-hosted runtime', () => {
    const out = patchHtmlForIframe(`
      <html><head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
        <script src="https://unpkg.com/katex@0.16.9/dist/katex.js"></script>
        <script src="//cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
      </head><body></body></html>
    `);

    expect(out).not.toContain('cdn.jsdelivr.net/npm/katex');
    expect(out).not.toContain('unpkg.com/katex');
    expect(out).toContain('/vendor/katex/katex.min.css');
    expect(out).toContain('/vendor/katex/katex.min.js');
    expect(out).toContain('/vendor/katex/auto-render.min.js');
  });

  it('moves the original action buttons into the mobile dock and restores them on desktop', () => {
    document.body.innerHTML = `
      <aside id="hidden-controls" style="display:none">
        <button id="start-btn">启动</button>
        <button id="reset-btn">重置</button>
      </aside>
      <main>实验画布</main>
    `;
    let mobile = true;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: mobile }),
    });

    const start = document.getElementById('start-btn') as HTMLButtonElement;
    let starts = 0;
    start.addEventListener('click', () => {
      starts += 1;
    });

    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-mobile-actions-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();
    new Function('window', 'document', 'MutationObserver', shim as string)(
      window,
      document,
      MutationObserver,
    );

    const dock = document.getElementById('maic-mobile-action-dock');
    expect(dock?.contains(start)).toBe(true);
    expect(document.body.classList.contains('maic-mobile-actions-visible')).toBe(true);
    start.click();
    expect(starts).toBe(1);

    mobile = false;
    window.dispatchEvent(new Event('resize'));
    expect(document.getElementById('hidden-controls')?.contains(start)).toBe(true);
    expect(document.getElementById('maic-mobile-action-dock')).toBeNull();
  });

  it('runs the storage shim before the page scripts', () => {
    const html =
      '<!DOCTYPE html><html><head><script>window.__x = localStorage.getItem("k");</script></head><body></body></html>';
    const out = patchHtmlForIframe(html);
    // The shim must appear before the page's own <script> so storage is safe by then.
    expect(out.indexOf('data-iframe-storage-shim')).toBeLessThan(out.indexOf('window.__x'));
  });

  it('the shim provides a working in-memory storage when the real one throws', () => {
    // Execute the injected shim against a fake window whose localStorage getter
    // throws (mirroring a null-origin sandboxed iframe), then assert the shim
    // installed a usable in-memory store.
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-storage-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const win: Record<string, unknown> = {};
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('sandboxed');
      },
    });
    Object.defineProperty(win, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sandboxed');
      },
    });
    new Function('window', shim as string)(win);

    const ls = win.localStorage as Storage;
    expect(ls.getItem('missing')).toBeNull();
    ls.setItem('a', '1');
    expect(ls.getItem('a')).toBe('1');
    expect(ls.length).toBe(1);
    ls.removeItem('a');
    expect(ls.getItem('a')).toBeNull();
  });

  it('creates a head when the authored document has none', () => {
    const out = patchHtmlForIframe('<div>no head</div>');
    expect(out.startsWith('<head>\n<meta name="viewport"')).toBe(true);
    expect(out.indexOf('data-iframe-error-shim')).toBeLessThan(out.indexOf('<div>'));
    expect(out.indexOf('</head>')).toBeLessThan(out.indexOf('<div>'));
  });

  it('does not treat head-like text in comments or scripts as the document head', () => {
    const authoredScript = 'const template = "<head>"; window.__template = template;';
    const html = `<!doctype html><!-- <head> --><html><body><script>${authoredScript}</script></body></html>`;
    const out = patchHtmlForIframe(html);

    expect(out).toContain(`<script>${authoredScript}</script>`);
    expect(out.indexOf('data-iframe-error-shim')).toBeLessThan(out.indexOf('<body>'));
  });

  it('injects the error-capture shim before the storage shim and page scripts', () => {
    const html = '<!DOCTYPE html><html><head><script>boom()</script></head><body></body></html>';
    const out = patchHtmlForIframe(html);
    expect(out).toContain('data-iframe-error-shim');
    // error shim runs first → before storage shim → before page scripts, so it
    // catches errors from everything that follows.
    expect(out.indexOf('data-iframe-error-shim')).toBeLessThan(
      out.indexOf('data-iframe-storage-shim'),
    );
    expect(out.indexOf('data-iframe-storage-shim')).toBeLessThan(out.indexOf('boom()'));
  });

  it('the error shim posts runtime errors (onerror / resource / rejection / console.error) to the parent', () => {
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-error-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const posts: Array<[Record<string, unknown>, string]> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const win = {
      parent: { postMessage: (m: Record<string, unknown>, o: string) => posts.push([m, o]) },
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        handlers[t] = cb;
      },
      console: { error: (..._args: unknown[]) => {} },
    };
    new Function('window', shim as string)(win);

    handlers.error({ message: 'JSON.parse boom', filename: 'p.html', lineno: 12 });
    expect(posts[0][0]).toMatchObject({ kind: 'runtime-error', errorKind: 'error' });
    expect(posts[0][0].message).toContain('JSON.parse boom');
    expect(posts[0][1]).toBe('*');

    handlers.error({ target: { src: 'https://cdn/katex.js' } });
    expect(String(posts[1][0].message)).toContain('Failed to load resource');

    handlers.unhandledrejection({ reason: { message: 'rej' } });
    expect(posts[2][0]).toMatchObject({ errorKind: 'unhandledrejection' });

    win.console.error('console boom');
    expect(posts[3][0]).toMatchObject({ errorKind: 'console.error' });
    expect(String(posts[3][0].message)).toContain('console boom');
  });

  it('the error shim buffers errors and re-emits them on a parent replay request', () => {
    // Guards the subscribe-after-insert race: a page that throws synchronously
    // while srcDoc parses may post before the parent subscribes. The shim must
    // re-emit the whole buffer when the parent asks, so nothing is lost.
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-error-shim>([\s\S]*?)<\/script>/)?.[1];
    const posts: Array<[Record<string, unknown>, string]> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const win = {
      parent: { postMessage: (m: Record<string, unknown>, o: string) => posts.push([m, o]) },
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        handlers[t] = cb;
      },
      console: { error: (..._args: unknown[]) => {} },
    };
    new Function('window', shim as string)(win);

    // Two errors fire "before the parent subscribed".
    handlers.error({ message: 'first boom' });
    handlers.unhandledrejection({ reason: { message: 'second boom' } });
    expect(posts).toHaveLength(2);

    // Parent now subscribes and requests a replay.
    handlers.message({ data: { __maicErrorReplayRequest: true } });
    expect(posts).toHaveLength(4);
    expect(String(posts[2][0].message)).toContain('first boom');
    expect(String(posts[3][0].message)).toContain('second boom');
    expect(posts[2][0]).toMatchObject({ kind: 'runtime-error', errorKind: 'error' });

    // An unrelated message must NOT trigger a replay.
    handlers.message({ data: { foo: 1 } });
    expect(posts).toHaveLength(4);
  });
});
