import { NextResponse } from 'next/server';

export function createBridgeCompleteResponse(
  destination: URL,
  parentOrigin: string
): NextResponse {
  const targetPath = `${destination.pathname}${destination.search}`;
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Opening WhatsApp CRM</title></head>
  <body>
    <p>Secure sign-in complete. Opening WhatsApp CRM…</p>
    <script>
      (() => {
        const parentOrigin = ${JSON.stringify(parentOrigin)};
        const destination = ${JSON.stringify(targetPath)};
        let navigated = false;
        const navigate = () => {
          if (navigated) return;
          navigated = true;
          window.location.replace(destination);
        };
        window.addEventListener('message', (event) => {
          if (
            event.source === window.parent &&
            event.origin === parentOrigin &&
            event.data?.type === 'wacrm:bridge-complete-ack'
          ) {
            navigate();
          }
        });
        window.parent.postMessage({ type: 'wacrm:bridge-complete' }, parentOrigin);
        window.setTimeout(navigate, 1500);
      })();
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
