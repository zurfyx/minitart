import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuSeconds,
  duSizes,
  POINTS,
  Resources,
  STEP_MS,
  vmOfFiles,
  vmProcesses,
  type ResourcesDeps,
} from './resources.ts';

const VZ =
  '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine';
const GB = 1024 ** 3;

test('CPU time is read however ps writes it', () => {
  assert.equal(cpuSeconds('0:04.53'), 4.53);
  assert.equal(cpuSeconds('12:00.00'), 720);
  assert.equal(cpuSeconds('1:02:03.50'), 3723.5);
  assert.equal(cpuSeconds('2-01:00:00'), 2 * 86_400 + 3600);
  assert.equal(cpuSeconds('soon'), null);
});

test('only Virtualization processes are VMs, whatever else is running', () => {
  const ps = [
    `  301 0:01.00  48224 /opt/homebrew/Cellar/tart/2.42.0/libexec/tart.app/Contents/MacOS/tart`,
    `29418 0:27.81 1582368 ${VZ}`,
    `  512 1:00.00 900000 /Applications/Some App.app/Contents/MacOS/com.apple.Virtualization.VirtualMachine helper`,
    'garbage',
  ].join('\n');
  assert.deepEqual(vmProcesses(ps), [{ pid: 29418, cpuSeconds: 27.81, rssBytes: 1582368 * 1024 }]);
});

test('which VM a process runs is the folder of the disk it has open', () => {
  const lsof = [
    'p29418',
    'n/System/Library/Frameworks/Virtualization.framework',
    'n/Users/me/.tart/vms/minitart-linux-0a1b2c/nvram.bin',
    'n/Users/me/.tart/vms/minitart-linux-0a1b2c/disk.img',
  ].join('\n');
  assert.equal(vmOfFiles(lsof, '/Users/me/.tart'), 'minitart-linux-0a1b2c');
  assert.equal(vmOfFiles('p1\nn/Users/me/Documents/x', '/Users/me/.tart'), null);
});

test('du sizes are kilobytes, by path', () => {
  const sizes = duSizes('5023628\t/t/vms/minitart-base-linux\n80\t/t/cache\nnot a line\n');
  assert.equal(sizes.get('/t/vms/minitart-base-linux'), 5023628 * 1024);
  assert.equal(sizes.get('/t/cache'), 80 * 1024);
});

/** A Mac of 10 cores and 64 GB whose clock, CPU counters and processes the test moves. */
function mac() {
  const world = {
    now: 1_000_000,
    busy: 0,
    total: 0,
    available: (40 * 1024) as number | null,
    processes: new Map<number, { name: string; seconds: number; rss: number }>(),
    lsofCalls: 0,
    du: '' as string | null,
    statfsPaths: [] as string[],
  };
  const deps: ResourcesDeps = {
    cores: 10,
    memoryBytes: 64 * GB,
    tartHome: '/t',
    now: () => world.now,
    cpuTimes: () => ({ busy: world.busy, total: world.total }),
    availableMb: () => world.available,
    images: () => ['minitart-base-linux', 'minitart-base-macos'],
    statfs: async (path) => {
      world.statfsPaths.push(path);
      if (path !== '/System/Volumes/Data') throw new Error('no such volume');
      return { bsize: 4096, blocks: (1000 * GB) / 4096, bavail: (700 * GB) / 4096 };
    },
    run: async (command, args) => {
      if (command === 'ps') {
        return [...world.processes]
          .map(([pid, p]) => `${pid} 0:${p.seconds.toFixed(2)} ${p.rss / 1024} ${VZ}`)
          .join('\n');
      }
      if (command === 'lsof') {
        world.lsofCalls++;
        const vm = world.processes.get(Number(args.at(-1)));
        return vm ? `p1\nn/t/vms/${vm.name}/disk.img\n` : null;
      }
      if (command === 'du') return world.du;
      return null;
    },
  };
  return { world, resources: new Resources(deps) };
}

test('a point splits CPU and memory between minitart’s job VMs and everything else', async () => {
  const { world, resources } = mac();
  world.processes.set(7, { name: 'minitart-linux-0a1b2c', seconds: 10, rss: 6 * GB });
  // The owner's own VM, or an image being built: the Mac's, not minitart's jobs'.
  world.processes.set(8, { name: 'my-vm', seconds: 10, rss: 2 * GB });
  await resources.sample();
  assert.equal(resources.view().points.length, 0, 'the first sample only sets the start');

  // Ten seconds on: half the Mac busy, of which the job VM used 2 cores' worth.
  world.now += STEP_MS;
  world.busy += 50;
  world.total += 100;
  world.processes.get(7)!.seconds += 20;
  world.processes.get(8)!.seconds += 10;
  await resources.sample();
  const [point] = resources.view().points;
  assert.deepEqual(point, {
    at: world.now,
    cpuVms: 20,
    cpuOther: 30,
    memVms: 6 * 1024,
    // 64 GB, less the 40 GB macOS has to spare, less the job VM's 6.
    memOther: 18 * 1024,
  });
  assert.equal(world.lsofCalls, 2, 'each process is asked about once');
});

test('a VM first seen now counts from its next point, and one that is gone is forgotten', async () => {
  const { world, resources } = mac();
  await resources.sample();
  world.now += STEP_MS;
  world.busy += 10;
  world.total += 100;
  world.processes.set(7, { name: 'minitart-macos-0a1b2c', seconds: 500, rss: GB });
  await resources.sample();
  assert.equal(resources.view().points[0]?.cpuVms, 0, 'its CPU time so far is not this point’s');

  world.processes.delete(7);
  world.now += STEP_MS;
  world.busy += 10;
  world.total += 100;
  await resources.sample();
  assert.equal(resources.view().points[1]?.memVms, 0);
});

test('an hour of points is kept, and no more', async () => {
  const { world, resources } = mac();
  for (let i = 0; i <= POINTS + 5; i++) {
    world.now += STEP_MS;
    world.busy += 1;
    world.total += 10;
    await resources.sample();
  }
  const points = resources.view().points;
  assert.equal(points.length, POINTS);
  assert.equal(points.at(-1)?.at, world.now);
});

test('disk: the data volume, and what Tart keeps of each image and of its downloads', async () => {
  const { world, resources } = mac();
  world.du = `5000000\t/t/vms/minitart-base-linux\n80000000\t/t/vms/minitart-base-macos\n100\t/t/cache\n`;
  await resources.sample();
  const disk = resources.view().disk;
  assert.equal(world.statfsPaths[0], '/System/Volumes/Data', 'not the sealed system volume');
  assert.equal(disk?.totalBytes, 1000 * GB);
  assert.equal(disk?.freeBytes, 700 * GB);
  assert.deepEqual(
    disk?.tart.map((entry) => [entry.name, entry.bytes / 1024]),
    [
      ['minitart-base-linux', 5000000],
      ['minitart-base-macos', 80000000],
      ['Downloaded images', 100],
    ],
  );
  // Measured again only after ten minutes.
  world.du = null;
  world.now += STEP_MS;
  await resources.sample();
  assert.equal(resources.view().disk?.tart.length, 3);
});

test('memory not known from macOS is not made up', async () => {
  const { world, resources } = mac();
  world.available = null;
  await resources.sample();
  world.now += STEP_MS;
  world.total += 100;
  await resources.sample();
  assert.equal(resources.view().points[0]?.memOther, 0);
});
