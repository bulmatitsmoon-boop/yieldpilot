#!/usr/bin/env node
// Postinstall patch: neutralize the vulnerable native binding in EVERY installed
// copy of bigint-buffer (npm's own package.json `overrides` cannot reliably target
// this -- nested-override `file:` paths resolve relative to the nested package's
// own location, not the project root, confirmed live 2026-09-03 trying exactly
// that).
//
// This finds every node_modules/**/bigint-buffer/dist/node.js and overwrites it
// with a version that skips the native-binding attempt entirely, falling straight
// to the pure-JS path. That pure-JS path is bigint-buffer's OWN code, copied
// verbatim -- this changes nothing about behavior, since our build has never
// successfully loaded the native binding anyway (every build logs "Failed to load
// bindings, pure JS will be used"). It just makes that the only path, so the
// vulnerable native code (GHSA-3gc7-fjrx-p6mg, a buffer overflow in the native
// toBigIntLE) can never be reached, from any copy, at any nesting depth.
var fs = require('fs');
var path = require('path');

var lines = [
  "'use strict';",
  'Object.defineProperty(exports, "__esModule", { value: true });',
  '// PATCHED (see scripts/patch-bigint-buffer.js): native binding attempt removed',
  '// entirely -- this app has always fallen back to the pure-JS path below anyway',
  '// (native bindings never successfully loaded in this environment), so this',
  '// change is behavior-neutral. It exists solely to make the vulnerable native',
  '// code (GHSA-3gc7-fjrx-p6mg) permanently unreachable rather than just unused.',
  'function toBigIntLE(buf) {',
  '    var reversed = Buffer.from(buf);',
  '    reversed.reverse();',
  "    var hex = reversed.toString('hex');",
  '    if (hex.length === 0) { return BigInt(0); }',
  "    return BigInt('0x' + hex);",
  '}',
  'exports.toBigIntLE = toBigIntLE;',
  'function toBigIntBE(buf) {',
  "    var hex = buf.toString('hex');",
  '    if (hex.length === 0) { return BigInt(0); }',
  "    return BigInt('0x' + hex);",
  '}',
  'exports.toBigIntBE = toBigIntBE;',
  'function toBufferLE(num, width) {',
  '    var hex = num.toString(16);',
  "    var buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');",
  '    buffer.reverse();',
  '    return buffer;',
  '}',
  'exports.toBufferLE = toBufferLE;',
  'function toBufferBE(num, width) {',
  '    var hex = num.toString(16);',
  "    return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');",
  '}',
  'exports.toBufferBE = toBufferBE;',
  '',
];
var SAFE_NODE_JS = lines.join('\n');

function findAll(dir, name, results) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry.isDirectory()) continue;
    var full = path.join(dir, entry.name);
    if (entry.name === name) {
      results.push(full);
    } else if (entry.name === 'node_modules' || entry.name.charAt(0) !== '.') {
      findAll(full, name, results);
    }
  }
}

var results = [];
findAll(path.join(__dirname, '..', 'node_modules'), 'bigint-buffer', results);

if (results.length === 0) {
  console.log('[patch-bigint-buffer] no installed copies found -- nothing to patch');
  process.exit(0);
}

var patched = 0;
for (var j = 0; j < results.length; j++) {
  var dir = results[j];
  var nodeJsPath = path.join(dir, 'dist', 'node.js');
  if (fs.existsSync(nodeJsPath)) {
    fs.writeFileSync(nodeJsPath, SAFE_NODE_JS);
    patched++;
    console.log('[patch-bigint-buffer] patched', nodeJsPath);
  }
}
console.log('[patch-bigint-buffer] done -- ' + patched + '/' + results.length + ' installed copies patched');
