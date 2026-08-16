// Stub every non-relative require with a universal callable Proxy so we can
// EXECUTE each module and surface load-time crashes (ReferenceError, TypeError)
// that `node --check` cannot see — e.g. an identifier whose import line was
// deleted while its call site survived.
const Module = require('module');
const path = require('path');
const fs = require('fs');

function mkStub() {
  const f = function () { return mkStub(); };
  return new Proxy(f, {
    get(t, p) {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => 'stub';
      if (p === 'toString') return () => 'stub';
      if (p === Symbol.iterator) return function* () {};
      if (p === 'prototype') return t.prototype;
      if (p === Symbol.toStringTag) return 'stub';
      return mkStub();
    },
    apply() { return mkStub(); },
    construct() { return mkStub(); },
    has() { return true; },
  });
}

function isExternal(request) {
  if (request.startsWith('.') || request.startsWith('/')) return false;
  return !Module.builtinModules.includes(request.replace(/^node:/, ''));
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (isExternal(request)) return mkStub();
  return origLoad.call(this, request, parent, isMain);
};

const root = process.argv[2];
const targets = process.argv.slice(3);
let failures = 0;

for (const rel of targets) {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  try {
    require(abs);
  } catch (e) {
    const interesting =
      e instanceof ReferenceError ||
      (e instanceof TypeError && /is not a function|is not a constructor|of undefined|of null|Cannot read/.test(e.message));
    if (interesting) {
      failures++;
      const frame = (e.stack || '').split('\n').find((l) => l.includes(root)) || '';
      console.log('LOAD-CRASH ' + path.relative(root, abs) + ': ' + e.name + ': ' + e.message);
      if (frame) console.log('           ' + frame.trim());
    }
  }
}

console.log(failures ? '\n' + failures + ' module(s) crash on load' : '\nno load-time crashes detected');
