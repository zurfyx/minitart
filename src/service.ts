// `minitart service install`: a LaunchAgent in the owner's account (D09), so minitart
// starts at login and comes back if it stops. An agent, not a daemon: Tart runs VMs from a
// logged-in session.

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'sh.rovira.minitart';

export function plistPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function plist(options: {
  node: string;
  main: string;
  args: readonly string[];
  log: string;
  path: string;
}): string {
  const args = [options.node, options.main, 'start', ...options.args]
    .map((arg) => `    <string>${escape(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(options.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escape(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(options.log)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
    });
  });
}

export async function installService(options: {
  main: string;
  args: readonly string[];
  log: string;
}): Promise<string> {
  const path = plistPath();
  const domain = `gui/${userInfo().uid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    plist({
      node: process.execPath,
      main: options.main,
      args: options.args,
      log: options.log,
      // Homebrew's bin, where tart and softnet live, is not on a LaunchAgent's PATH.
      path: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    }),
  );
  await launchctl(['bootout', `${domain}/${LABEL}`]);
  const loaded = await launchctl(['bootstrap', domain, path]);
  if (!loaded.ok) throw new Error(`launchctl could not load ${path}: ${loaded.output}`);
  return path;
}

export async function uninstallService(): Promise<void> {
  await launchctl(['bootout', `gui/${userInfo().uid}/${LABEL}`]);
  rmSync(plistPath(), { force: true });
}
