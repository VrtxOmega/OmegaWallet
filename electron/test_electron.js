// Minimal test — does `app` exist from require('electron')?
const electron = require('electron');
console.log('electron type:', typeof electron);

// If electron is a string (path), we need to use it differently
if (typeof electron === 'string') {
    console.log('electron is a path:', electron);
    console.log('Trying default export...');
    // Electron v33+ may use ESM-style default export
    const { app, BrowserWindow } = require('electron');
    console.log('app:', typeof app);
    console.log('BrowserWindow:', typeof BrowserWindow);
} else {
    console.log('app:', typeof electron.app);
    console.log('BrowserWindow:', typeof electron.BrowserWindow);
}
