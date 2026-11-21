import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export async function setup(): Promise<void> {
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  // The tests exercise the package exports and CLI from dist.
  const build = spawn('npm run build', { cwd, shell: true, stdio: 'inherit' });
  const [code, signal] = await once(build, 'close');
  if (code !== 0) {
    const reason = code === null ? `was terminated by ${signal}` : `exited with code ${code}`;
    throw new Error(`npm run build ${reason}`);
  }
}
