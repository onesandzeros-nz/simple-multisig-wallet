/**
 * RN-environment smoke test (run with: npm run smoke).
 *
 * Bundles the polyfills + wallet engine exactly as Metro would (same module
 * graph, same stream alias), then executes the bundle inside a bare VM
 * context that mimics Hermes on a device: NO Buffer, NO process.version,
 * no Node globals — just timers and crypto.getRandomValues. Catches
 * "works in Node, crashes on device" module-scope errors before a build.
 */
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const esbuild = require('esbuild');

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'smoke-entry.js')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    alias: {
      stream: 'stream-browserify',
      // native module — replaced by the context's crypto.getRandomValues
      'react-native-get-random-values': path.join(__dirname, 'smoke-noop.js'),
    },
    // Only reached by the emulator tests, which the smoke run never calls.
    external: ['net'],
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;

  // Hermes-like context: deliberately NO Buffer and a process WITHOUT version.
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    process: { env: {} },
    crypto: { getRandomValues: (arr) => crypto.webcrypto.getRandomValues(arr) },
    TextEncoder,
    TextDecoder,
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Hermes quirk: TypedArray.prototype.subarray ignores @@species, so a
  // Buffer's subarray() returns a plain Uint8Array there (V8 returns a
  // Buffer). Emulate that so species-dependent code fails here, not on
  // the device.
  vm.runInContext(
    `(() => {
      const orig = Uint8Array.prototype.subarray;
      Uint8Array.prototype.subarray = function (begin, end) {
        const r = orig.call(this, begin, end);
        return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
      };
    })();`,
    sandbox
  );

  try {
    vm.runInContext(code, sandbox, { filename: 'bundle.js' });
  } catch (e) {
    console.error('💥 bundle crashed in RN-like environment:\n');
    console.error(e.stack ?? e);
    process.exit(1);
  }
  if (!sandbox.__SMOKE_OK__) {
    console.error('💥 bundle ran but did not complete');
    process.exit(1);
  }
  try {
    await sandbox.__SMOKE_ASYNC__;
  } catch (e) {
    console.error('💥 hardware wallet drivers failed in RN-like environment:\n');
    console.error(e.stack ?? e);
    process.exit(1);
  }
  console.log('🎉 engine runs clean in RN-like environment (no Buffer, no process.version)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
