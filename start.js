const { spawn } = require('child_process');
const path = require('path');

let sqliteOk = false;
try {
  require('node:sqlite');
  sqliteOk = true;
} catch (_) {}

const args = [];
if (!sqliteOk) args.push('--experimental-sqlite');
args.push(path.join(__dirname, 'server.js'));

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: __dirname });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
