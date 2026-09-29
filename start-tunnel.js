const { spawn } = require('child_process');

const cloudflaredPath = 'C:\\PROGRAM FILES (X86)\\CLOUDFLARED\\CLOUDFLARED.EXE';
const args = ['tunnel', '--protocol', 'http2', '--url', 'http://localhost:3001'];

console.log('[tunnel] Starting cloudflared with http2 for Russia compatibility on http://localhost:3001...');
const child = spawn(cloudflaredPath, args, { stdio: 'inherit' });

child.on('error', (err) => {
  console.error('[tunnel] Process error:', err);
});

child.on('exit', (code, signal) => {
  console.log(`[tunnel] Process exited with code ${code}, signal ${signal}`);
  process.exit(code ?? 0);
});
