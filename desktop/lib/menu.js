'use strict';

const { Menu } = require('electron');

/**
 * A small menu: macOS needs an Edit menu for copy and paste shortcuts to
 * reach the page at all, and zoom helps on a large screen. Reload and the
 * developer tools are only offered in a development run.
 */
function buildMenu({ isDev }) {
  const isMac = process.platform === 'darwin';
  const view = [
    ...(isDev ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

/** Cut, copy, paste and select all on a right-click in a text field or over a selection; otherwise nothing. */
function editContextMenu(params) {
  if (!params.isEditable && !params.selectionText) return null;
  const flags = params.editFlags || {};
  return Menu.buildFromTemplate([
    { role: 'cut', enabled: !!flags.canCut },
    { role: 'copy', enabled: !!flags.canCopy },
    { role: 'paste', enabled: !!flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: !!flags.canSelectAll },
  ]);
}

module.exports = { buildMenu, editContextMenu };
