import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export async function startReportWorker() {
  const log = createWriteStream('.local/report-worker-browser.log', { flags: 'a', mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['DATABASE_URL', 'MIGRATION_DATABASE_URL'].includes(name)));
  const child = spawn(process.execPath, ['--env-file=.env.worker.local', 'scripts/report-worker.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => finish(new Error('Report worker did not become ready.')), 15_000);
      const onData = (chunk) => { output += chunk.toString(); if (output.includes('is ready for renderer')) finish(); };
      const onExit = () => finish(new Error('Report worker exited before becoming ready.'));
      const onError = () => finish(new Error('Report worker could not start.'));
      function finish(error) {
        clearTimeout(timeout); child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
        if (error) reject(error); else resolve();
      }
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
    });
  } catch (error) { child.kill('SIGTERM'); log.end(); throw error; }
  return async () => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(timeout); log.end(); }
  };
}
