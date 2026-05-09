export function buildSplashHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covel</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #09090b; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    overflow: hidden; -webkit-app-region: drag; user-select: none;
  }
  @media (prefers-color-scheme: light) {
    body { background: #fafafa; color: #09090b; }
    .brand { color: #18181b !important; }
    #status { color: #52525b !important; }
    .btn { background: #f4f4f5 !important; border-color: #e4e4e7 !important; color: #18181b !important; }
    .btn:hover { background: #e4e4e7 !important; }
    #log-viewer { background: #f4f4f5 !important; border-color: #e4e4e7 !important; }
    #log-content { color: #52525b !important; }
  }
  .brand { font-size: 42px; font-weight: 700; letter-spacing: 0.08em; color: #e4e4e7;
    margin-bottom: 48px; opacity: 0; animation: fade-in 0.6s ease-out 0.15s forwards; }
  .spinner-wrap { position: relative; width: 56px; height: 56px; margin-bottom: 40px;
    opacity: 0; animation: fade-in 0.6s ease-out 0.35s forwards; }
  .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid transparent; }
  .ring-1 { border-top-color: #a1a1aa; animation: spin 1.1s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite; }
  .ring-2 { inset: 6px; border-right-color: #71717a; animation: spin 1.6s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite reverse; }
  .ring-3 { inset: 12px; border-bottom-color: #52525b; animation: spin 2.2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite; }
  .dot { position: absolute; width: 4px; height: 4px; background: #d4d4d8; border-radius: 50%;
    top: 50%; left: 50%; transform: translate(-50%, -50%); animation: pulse 2s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.6); }
  }
  @keyframes fade-in { to { opacity: 1; } }
  #status { font-size: 13px; color: #a1a1aa; letter-spacing: 0.04em; min-height: 20px;
    opacity: 0; animation: fade-in 0.6s ease-out 0.5s forwards; transition: color 0.3s ease; }
  .error-wrap { display: none; flex-direction: column; align-items: center; gap: 10px;
    margin-top: 24px; opacity: 0; animation: fade-in 0.4s ease-out forwards; }
  .error-wrap.visible { display: flex; }
  .error-title { font-size: 14px; font-weight: 600; color: #f87171; }
  .error-msg { font-size: 12px; color: #a1a1aa; text-align: center; max-width: 460px; line-height: 1.5; }
  .error-hint { font-size: 12px; color: #d4d4d8; text-align: center; max-width: 460px; line-height: 1.5; margin-top: 4px; }
  .btn-row { display: flex; gap: 10px; -webkit-app-region: no-drag; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
  .btn { padding: 7px 18px; border-radius: 6px; border: 1px solid #27272a; background: #18181b;
    color: #d4d4d8; font-size: 12px; font-weight: 500; cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease; letter-spacing: 0.02em; }
  .btn:hover { background: #27272a; border-color: #3f3f46; }
  .btn-primary { background: #27272a; border-color: #3f3f46; }
  .btn-primary:hover { background: #3f3f46; border-color: #52525b; }
  #log-viewer { display: none; margin-top: 16px; padding: 12px 16px; background: #18181b;
    border: 1px solid #27272a; border-radius: 8px; max-width: 560px; max-height: 200px;
    overflow-y: auto; width: 90vw; -webkit-app-region: no-drag; }
  #log-viewer.visible { display: block; }
  #log-content { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 11px; color: #a1a1aa; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
</style>
</head>
<body>
  <div class="brand">COVEL</div>
  <div class="spinner-wrap" id="spinner">
    <div class="ring ring-1"></div><div class="ring ring-2"></div>
    <div class="ring ring-3"></div><div class="dot"></div>
  </div>
  <div id="status">Initializing\u2026</div>

  <div class="error-wrap" id="error-wrap">
    <div class="error-title" id="error-title">Startup failed</div>
    <div class="error-msg" id="error-msg"></div>
    <div class="error-hint" id="error-hint"></div>
    <div class="btn-row">
      <button class="btn btn-primary" id="btn-retry">Retry</button>
      <button class="btn" id="btn-logs">View Logs</button>
      <button class="btn" id="btn-open-logs">Open Logs Folder</button>
      <button class="btn" id="btn-open-data">Open Data Folder</button>
    </div>
  </div>

  <div id="log-viewer"><div id="log-content"></div></div>

  <script>
    const ipc = window.covelIpc;
    document.getElementById('btn-retry').addEventListener('click', () => ipc.invoke('covel:retry-startup'));
    document.getElementById('btn-logs').addEventListener('click', () => {
      document.getElementById('log-viewer').classList.toggle('visible');
    });
    document.getElementById('btn-open-logs').addEventListener('click', () => ipc.invoke('covel:open-logs-dir'));
    document.getElementById('btn-open-data').addEventListener('click', () => ipc.invoke('covel:open-data-dir'));

    ipc.on('covel:startup:progress', (payload) => {
      document.getElementById('status').textContent = payload && payload.label ? payload.label : 'Loading\u2026';
    });

    ipc.on('covel:startup:error', (payload) => {
      document.getElementById('spinner').style.display = 'none';
      document.getElementById('status').style.color = '#71717a';
      document.getElementById('status').textContent = 'Startup failed';
      document.getElementById('error-title').textContent = payload.title || 'Startup failed';
      document.getElementById('error-msg').textContent = payload.detail || '';
      document.getElementById('error-hint').textContent = payload.hint || '';
      document.getElementById('log-content').textContent = payload.logs || '';
      document.getElementById('error-wrap').classList.add('visible');
    });
  </script>
</body>
</html>`;
}
