// Import first in any test file whose code under test prints with console.log
// (enforced for scripts/jobs.mjs importers by jobs-test-stdout.test.mjs).
//
// `node --test` runs each file in a child process and reads that child's stdout
// as a binary frame protocol. Plain text on the same stdout (e.g. the progress
// lines scripts/jobs.mjs prints) is tolerated, but Node 22's parser
// (lib/internal/test_runner/runner.js, still unfixed on v22.x) mis-frames the
// stream when such text is followed by a frame whose first bytes straddle a
// pipe-read boundary. The parent then spins forever in #drainRawBuffer at 100%
// CPU and ignores SIGTERM. Read boundaries depend on load, so this showed up as
// a rare hang only in parallel full-suite runs. Keeping stdout frame-only makes
// the suite deterministic; the text stays visible on stderr.
import { Console } from 'node:console';

const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr });
for (const method of ['log', 'info', 'debug', 'dir', 'dirxml', 'table']) {
  console[method] = toStderr[method].bind(toStderr);
}
