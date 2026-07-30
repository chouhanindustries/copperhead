// Standalone entry point spawned as a REAL, separate OS process by
// test/run-metrics.test.ts (AC-16.2). Runs `runAgentLoop` against two quick
// scripted turns and a third that hangs forever, so the parent test can wait
// for exactly two `llm-call` events to land, SIGKILL this process, and assert
// they survived — a guarantee that can only be demonstrated across a real
// process boundary, not by calling runAgentLoop() in-process.
import type { Provider, Turn } from '../../../src/agent/types.js';
import { runAgentLoop } from '../../../src/agent/loop.js';

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error('usage: sigkill-run.ts <repoRoot>');
  process.exit(2);
}

const quickTurn = (id: string): Turn => ({
  text: 'working',
  toolCalls: [{ id, name: 'bogus_tool', args: {} }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

class TwoThenHangProvider implements Provider {
  readonly name = 'sigkill-fixture';
  private i = 0;
  async chat(): Promise<Turn> {
    this.i++;
    if (this.i <= 2) return quickTurn(`t${this.i}`);
    // Third call never resolves — this process is expected to be SIGKILLed
    // while this promise is pending, not to exit on its own.
    return new Promise<Turn>(() => {});
  }
}

// Referenced (not unref'd), so this process cannot exit on its own while the
// third provider call hangs. A pending promise does not hold the event loop
// open by itself, and the loop's own heartbeat timer is unref'd — without
// this, nothing guarantees the process survives long enough for the parent
// to actually deliver the SIGKILL the test is meant to exercise (caught in
// review).
setInterval(() => {}, 60_000);

await runAgentLoop({
  repoRoot,
  request: 'sigkill survival fixture',
  model: 'sigkill-fixture',
  provider: new TwoThenHangProvider(),
  allowDirty: true,
  maxTurns: 10,
  log: () => {},
});
