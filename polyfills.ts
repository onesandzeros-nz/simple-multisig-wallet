// Global shims for the bitcoin libraries. This module must be imported
// before anything that touches Buffer/process — keeping the assignments
// in their own module guarantees they run before later imports load,
// since ES imports are hoisted but modules execute in import order.
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// @ts-ignore
global.Buffer = Buffer;

// React Native defines `process` but not everything Node-targeting libs
// expect. readable-stream reads process.version.slice(...) at module scope
// unless process.browser is set; process-nextick-args needs a nextTick.
// @ts-ignore
const proc = (global.process = global.process ?? {});
proc.env = proc.env ?? {};
// @ts-ignore
proc.browser = true;
if (!proc.nextTick) {
  // @ts-ignore
  proc.nextTick = (cb: (...a: any[]) => void, ...args: any[]) => setTimeout(() => cb(...args), 0);
}
