import { NextRequest, NextResponse } from 'next/server';
import { BRAND_MARK_PATH, BRAND_NAME } from '@/lib/brand';
import {
  buildRequestOrigin,
  isValidClassroomId,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

export const runtime = 'nodejs';

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function documentShell(body: string, title = BRAND_NAME): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <title>${escapeAttribute(title)}</title>
  <link rel="icon" href="${escapeAttribute(BRAND_MARK_PATH)}">
  <style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#000}
    iframe{display:block;width:100%;height:100%;border:0;background:#fff}
    .state{display:grid;width:100%;height:100%;place-items:center;padding:24px;color:#d1d5db;background:#000;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}
  </style>
</head>
<body>${body}</body>
</html>`;
}

function htmlResponse(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { readonly params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidClassroomId(id)) {
    return htmlResponse(documentShell('<main class="state">课程地址无效</main>'), 400);
  }

  const classroom = await readClassroom(id);
  if (!classroom || classroom.scenes.length === 0) {
    return htmlResponse(documentShell('<main class="state">课程暂时无法加载</main>'), 404);
  }

  // The zero-bundle path deliberately handles the product's fast-path output:
  // one or more self-contained interactive HTML pages. Slide/quiz/PBL courses
  // retain the complete React runtime and its specialized renderers.
  const pages = classroom.scenes.flatMap((scene) => {
    if (scene.type !== 'interactive' || scene.content.type !== 'interactive') return [];
    return [
      {
        html: scene.content.html ? patchHtmlForIframe(scene.content.html) : '',
        url: scene.content.html ? '' : (scene.content.url ?? ''),
      },
    ];
  });
  if (pages.length !== classroom.scenes.length) {
    // CloudBase reaches the container through its internal 0.0.0.0:3000
    // listener. Never expose that origin in a public redirect; use the same
    // canonical origin resolver as MCP and generation responses.
    const fallback = new URL(
      `/classroom/${encodeURIComponent(id)}`,
      buildRequestOrigin(request),
    );
    fallback.searchParams.set('full', '1');
    return NextResponse.redirect(fallback, 307);
  }

  const initial = pages[0];
  const iframe = `<iframe id="course" title="互动课程" sandbox="allow-scripts allow-forms allow-popups"${
    initial.html
      ? ` srcdoc="${escapeAttribute(initial.html)}"`
      : ` src="${escapeAttribute(initial.url)}"`
  }></iframe>`;

  // A single page needs no parent JavaScript at all. Multi-page interactive
  // courses keep invisible swipe/arrow navigation without adding UI chrome.
  let navigation = '';
  if (pages.length > 1) {
    const encodedPages = Buffer.from(JSON.stringify(pages), 'utf8').toString('base64');
    navigation = `<script>
      (function(){
        var pages=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodedPages}'),function(c){return c.charCodeAt(0)})));
        var frame=document.getElementById('course'),index=0,startX=null;
        function show(next){
          next=Math.max(0,Math.min(pages.length-1,next));
          if(next===index)return;index=next;
          if(pages[index].html){frame.removeAttribute('src');frame.srcdoc=pages[index].html}
          else{frame.removeAttribute('srcdoc');frame.src=pages[index].url}
        }
        addEventListener('keydown',function(e){if(e.key==='ArrowLeft')show(index-1);if(e.key==='ArrowRight')show(index+1)});
        addEventListener('touchstart',function(e){startX=e.changedTouches[0]&&e.changedTouches[0].clientX},{passive:true});
        addEventListener('touchend',function(e){var x=e.changedTouches[0]&&e.changedTouches[0].clientX;if(startX===null||x===undefined)return;var d=x-startX;startX=null;if(Math.abs(d)>48)show(index+(d<0?1:-1))},{passive:true});
      })();
    </script>`;
  }

  return htmlResponse(documentShell(`${iframe}${navigation}`, classroom.stage.name || BRAND_NAME));
}
