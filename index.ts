import './polyfills';

import { registerRootComponent } from 'expo';

import App from './App';
import { setupPlatform } from './src/platform/setup';

// On the desktop (the web bundle inside Electron) this points the React
// Native APIs react-native-web leaves empty at the shell's native dialogs.
setupPlatform();

registerRootComponent(App);
