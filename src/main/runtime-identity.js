'use strict';

// Local diagnostics only: paths identify the actual checkout/package in use.
// This is runtime identity, not source-integrity or dependency-capability proof.
function runtimeIdentity(app, runtime = process) {
  const versions = runtime.versions || {};
  const read = (method) => {
    try { return app && typeof app[method] === 'function' ? app[method]() : null; } catch (_) { return null; }
  };
  return {
    kind: versions.electron ? (app && app.isPackaged ? 'packaged-electron' : 'development-electron') : 'node',
    appVersion: read('getVersion'), appPath: read('getAppPath'),
    executable: runtime.execPath || null, platform: runtime.platform || null, architecture: runtime.arch || null,
    versions: { node: versions.node || null, electron: versions.electron || null, chrome: versions.chrome || null,
      modules: versions.modules || null }
  };
}
module.exports = { runtimeIdentity };
