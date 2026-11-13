// electron-builder configuration for the desktop releases.
// Windows: NSIS installer (x64, arm64) and a portable .exe (x64).
// macOS: universal (Apple silicon + Intel) .dmg and .zip, ad-hoc signed.
// Linux: AppImage and .deb for x64, arm64 (Raspberry Pi OS 64-bit, ChromeOS Linux on ARM) and
// armv7l (Raspberry Pi OS 32-bit).
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.socrtwo.quillpen',
  productName: 'Anne\'s Pen',
  executableName: 'QuillPen', // the binary keeps its old name; the product (display) name is Anne's Pen
  copyright: 'Copyright (c) 2026 Paul D Pruitt, MIT License',
  directories: { app: 'build/desktop-app', output: 'release', buildResources: 'resources' },
  artifactName: 'Annes-Pen-${version}-${os}-${arch}.${ext}',
  asar: true,
  // Electron fuses: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect, and only the packaged
  // (integrity-checked on Windows and macOS) app.asar runs.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  // Everything the app needs is bundled into dist/ by Vite; ship no node_modules.
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!**/node_modules/**'],
  icon: 'resources/icon-1024.png',
  // The web build, unpacked next to app.asar as resources/embed/, so Anne's Post desktop can run this editor
  // inside its own window (docs/EMBED.md). Paths are relative to the project folder.
  extraResources: [{ from: 'dist', to: 'embed', filter: ['**/*'] }],
  fileAssociations: [
    { ext: 'docx', name: 'Word Document', role: 'Editor', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { ext: 'odt', name: 'OpenDocument Text', role: 'Editor', mimeType: 'application/vnd.oasis.opendocument.text' },
    { ext: 'rtf', name: 'Rich Text Document', role: 'Editor', mimeType: 'application/rtf' },
    { ext: 'doc', name: 'Word 97-2003 Document', role: 'Viewer', mimeType: 'application/msword' },
    { ext: 'qpd', name: 'Anne\'s Pen Document', role: 'Editor' },
    { ext: 'qfd', name: 'Anne\'s Pen Document (QuillForge)', role: 'Editor' }, // rename:keep — Anne's Pen was named QuillForge; its .qfd/.qfde files still open
    { ext: ['wpd', 'wp5', 'wp6'], name: 'WordPerfect Document', role: 'Viewer', mimeType: 'application/vnd.wordperfect' },
    { ext: 'wps', name: 'Microsoft Works Document', role: 'Viewer', mimeType: 'application/vnd.ms-works' },
    { ext: 'wri', name: 'Windows Write Document', role: 'Viewer', mimeType: 'application/x-mswrite' },
    { ext: ['lwp', 'sam'], name: 'Lotus Word Pro / Ami Pro Document', role: 'Viewer' },
    { ext: 'hwp', name: 'Hangul Document', role: 'Viewer', mimeType: 'application/x-hwp' },
    { ext: ['ws', 'xy', 'rft', 'mcw', 'cwk'], name: 'Legacy Word Processor Document', role: 'Viewer' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'portable', arch: ['x64'] }],
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: 'Annes-Pen-${version}-windows-${arch}-setup.${ext}' },
  portable: { artifactName: 'Annes-Pen-${version}-windows-portable.${ext}' },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    // Ad-hoc signature: runs on Apple silicon without a paid Developer ID, but is not notarized,
    // so Gatekeeper asks once (docs/INSTALL.md). Hardened runtime would reject Electron's own signature.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64', 'armv7l'] }, { target: 'deb', arch: ['x64', 'arm64', 'armv7l'] }],
    category: 'Office',
    synopsis: 'Word processor with a complete, customizable command library',
    maintainer: 'socrtwo <socrtwo@users.noreply.github.com>',
    executableName: 'quillpen',
    syncDesktopName: true,
  },
  publish: null,
};
