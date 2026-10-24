// Installs (or with --uninstall, removes) the gateway as a Windows service that starts on boot.
// Run from an elevated (Administrator) terminal:  npm run service:install
const path = require('node:path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is not installed. Run:  npm install -g node-windows  &&  npm link node-windows');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const svc = new Service({
  name: 'AI Gateway',
  description: 'Local AI API gateway with key rotation (http://127.0.0.1:8787)',
  script: path.join(root, 'server', 'dist', 'index.js'),
  workingDirectory: root,
  env: [{ name: 'NODE_ENV', value: 'production' }],
  wait: 2,
  grow: 0.5,
  maxRestarts: 40,
});

if (process.argv.includes('--uninstall')) {
  svc.on('uninstall', () => console.log('AI Gateway service removed.'));
  svc.uninstall();
} else {
  svc.on('install', () => {
    console.log('AI Gateway service installed; starting…');
    svc.start();
  });
  svc.on('alreadyinstalled', () => console.log('Service already installed.'));
  svc.on('start', () => console.log('Started. Open http://127.0.0.1:8787'));
  svc.install();
}
