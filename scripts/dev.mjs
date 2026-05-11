import { spawn } from 'node:child_process';

// Windows-safe launcher. Some Node/npm versions on Windows can throw EINVAL
// when spawning npm.cmd directly, so we execute through the system shell.
const commands = [
  { name: 'server', command: 'npm run dev --prefix server' },
  { name: 'client', command: 'npm run dev --prefix client' }
];

const processes = commands.map(({ name, command }) => {
  const child = spawn(command, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
    windowsHide: false
  });

  child.on('error', (error) => {
    console.error(`\n[QuickLunch ${name}] no pudo iniciar: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`\n[QuickLunch ${name}] proceso finalizado con codigo ${code}.`);
    }
  });

  return child;
});

function shutdown() {
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
