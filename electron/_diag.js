// Runtime diagnostic — run with the ELECTRON BINARY, not node
console.log('process.versions.electron:', process.versions.electron);
console.log('process.versions.node:', process.versions.node);
console.log('ELECTRON_RUN_AS_NODE:', process.env.ELECTRON_RUN_AS_NODE);
console.log('process.type:', process.type);
const electron = require('electron');
console.log('typeof electron:', typeof electron);
if (typeof electron !== 'string' && electron.app) {
    console.log('SUCCESS: app module found');
    electron.app.quit();
} else {
    console.log('FAILURE: electron is a string or app undefined');
    process.exit(1);
}
