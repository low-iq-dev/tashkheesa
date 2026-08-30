'use strict';
// Guard: every pg-boss queue that is worked, sent to, or scheduled must first
// be created.
//
// WHY THIS FILE EXISTS
//
// 2026-08-30, seen in production the moment the environment was configured:
//
//   [production] [job-queue] pg-boss error: Queue classifier-learning does not
//   exist (Queue: classifier-learning, Worker: 305ff30b-...)
//
// pg-boss v12 does not create queues implicitly. work(), send() and schedule()
// all throw against an unregistered name. scheduleClassifierLearning() called
// work() and schedule() but never createQueue(), so:
//
//   * the classifier learning loop had never run a single time since it
//     shipped, silently — nothing downstream noticed, because its output is
//     only ever CANDIDATES for a human to approve; and
//   * because the scheduler retries, the failure was not one log line but a
//     continuous stream, which is how it was finally noticed.
//
// The six queues in start() were all created correctly. The seventh was added
// later, in its own function, and the createQueue call was the one line of the
// pattern that did not get copied. That is a mistake no runtime test catches —
// the unit suite never starts a real pg-boss — so it is a source-text check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Every file that may touch a pg-boss queue by name.
const SOURCES = ['src/job_queue.js', 'src/server.js', 'src/case_sla_worker.js'];

function scan() {
  const created = new Set();
  const used = new Map(); // name -> "file:line  call"
  for (const rel of SOURCES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      // Comments describe the calls; they are not the calls.
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      let m;
      // Anchored on the `boss` receiver. A bare /\.send\(/ also matches
      // Express's res.send('Forbidden'), which is not a queue and produced
      // four confident false positives the first time this ran.
      const create = /\bboss\s*\.\s*createQueue\(\s*'([^']+)'/g;
      while ((m = create.exec(code))) created.add(m[1]);
      const use = /\bboss\s*\.\s*(work|send|schedule)\(\s*'([^']+)'/g;
      while ((m = use.exec(code))) {
        if (!used.has(m[2])) used.set(m[2], rel + ':' + (i + 1) + '  .' + m[1] + "('" + m[2] + "')");
      }
    });
  }
  return { created, used };
}

test('every queue used is created first', () => {
  const { created, used } = scan();
  assert.ok(used.size > 0, 'found no pg-boss queue usage at all — has job_queue.js moved?');
  const missing = [];
  for (const [name, where] of used) {
    if (!created.has(name)) missing.push(name + '   ' + where);
  }
  assert.deepStrictEqual(missing, [],
    'These pg-boss queues are worked/sent/scheduled but never created.\n' +
    'pg-boss v12 throws "Queue <name> does not exist" and the scheduler retries,\n' +
    'so this is a continuous production error stream, not a one-off — and the\n' +
    'job itself never runs. Add `await boss.createQueue(\'<name>\')` before the\n' +
    'first work/send/schedule for it.\n  ' + missing.join('\n  '));
});

test('no queue is created but never used', () => {
  // The mirror image: a createQueue left behind after a worker was deleted
  // makes the next reader think that queue is live.
  const { created, used } = scan();
  const orphans = [...created].filter((n) => !used.has(n));
  assert.deepStrictEqual(orphans, [],
    'These queues are created but nothing works, sends or schedules them — ' +
    'either wire them up or drop the createQueue: ' + orphans.join(', '));
});
