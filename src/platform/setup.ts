/**
 * Platform setup that runs before the app renders. Nothing to do on the
 * phones; setup.web.ts, which the web bundle gets instead, wires the desktop
 * shell into the few React Native APIs react-native-web leaves empty.
 */
export function setupPlatform(): void {}
