// `minitart image build <kind>`: the image every job VM of that kind is cloned from (D11).
// It is an upstream image plus the GitHub Actions runner (and Docker, on Linux), built on
// this Mac by a script anyone can read (images/*.sh).

import { readFileSync } from 'node:fs';
import type { Fetch } from './github/client.ts';
import { guestShell } from './manager.ts';
import type { Pool } from './settings.ts';
import type { Network, Tart } from './tart.ts';

/** Where an image starts from when `--from` is not given. */
export const UPSTREAM: Record<Pool, string> = {
  linux: 'ghcr.io/cirruslabs/ubuntu:latest',
  macos: 'ghcr.io/cirruslabs/macos-tahoe-base:latest',
};

const RUNNER_ASSET: Record<Pool, string> = { linux: 'linux-arm64', macos: 'osx-arm64' };

export interface RunnerRelease {
  version: string;
  url: string;
  sha256: string;
}

/** The newest runner release and the checksum GitHub publishes for it. */
export async function latestRunner(pool: Pool, fetchImpl: Fetch = fetch): Promise<RunnerRelease> {
  const response = await fetchImpl('https://api.github.com/repos/actions/runner/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'minitart' },
  });
  if (!response.ok) throw new Error(`Could not read the runner release (${response.status})`);
  const release = (await response.json()) as { tag_name: string; body: string };
  return parseRunnerRelease(release, pool);
}

export function parseRunnerRelease(
  release: { tag_name: string; body: string },
  pool: Pool,
): RunnerRelease {
  const asset = RUNNER_ASSET[pool];
  const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
  const sha256 = new RegExp(`BEGIN SHA ${asset} -->([0-9a-f]{64})<!--`).exec(release.body)?.[1];
  if (!version || !sha256) {
    throw new Error(`The runner release ${release.tag_name} has no checksum for ${asset}`);
  }
  return {
    version,
    sha256,
    url: `https://github.com/actions/runner/releases/download/v${version}/actions-runner-${asset}-${version}.tar.gz`,
  };
}

export interface BuildOptions {
  tart: Tart;
  pool: Pool;
  /** The image to start from. */
  from: string;
  /** The name the finished image gets: the kind's image in the settings. */
  name: string;
  network: Network;
  runner: RunnerRelease;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function buildImage(options: BuildOptions): Promise<void> {
  const { tart, pool, from, name, network, runner, print } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const staging = `minitart-build-${pool}`;
  const script = readFileSync(new URL(`../images/${pool}.sh`, import.meta.url), 'utf8');

  const existing = new Set((await tart.list()).map((vm) => vm.name));
  if (existing.has(staging)) {
    await tart.stop(staging).catch(() => {});
    await tart.remove(staging);
  }
  if (!existing.has(from)) {
    print(`Pulling ${from}`);
    await tart.pull(from, print);
  }
  await tart.clone(from, staging);
  try {
    print(`Booting ${staging}`);
    let exited = false;
    void tart.boot(staging, network, print).then(() => {
      exited = true;
    });
    for (let waited = 0; (await tart.exec(staging, ['true'])) !== 0; waited++) {
      if (exited) throw new Error('the VM stopped while booting');
      if (waited > 300) throw new Error('the VM did not come up in time');
      await sleep(1000);
    }
    print(`Installing the runner ${runner.version}`);
    const code = await tart.exec(
      staging,
      guestShell(
        pool,
        `export RUNNER_URL='${runner.url}' RUNNER_SHA256='${runner.sha256}'\n${script}`,
      ),
      { onLine: print },
    );
    if (code !== 0) throw new Error(`the install script exited with code ${code}`);
    await tart.stop(staging);
  } catch (error) {
    await tart.stop(staging).catch(() => {});
    await tart.remove(staging).catch(() => {});
    throw error;
  }
  // The old image goes only once the new one is whole.
  if (existing.has(name)) await tart.remove(name);
  await tart.rename(staging, name);
  print(`${name} is ready`);
}
