const path = require('path');

// Detect if we're building for Mac App Store
const isMAS = process.argv.includes('--platform=mas') ||
              process.env.npm_config_platform === 'mas';

module.exports = {
  hooks: {
    postStart: async (config, child) => {
      child.on('exit', (code, signal) => {
        process.exit(0);
      });
    }
  },
  packagerConfig: {
    asar: {
      unpack: '{**/*.node,**/*.dylib,**/*.metallib}'
    },
    icon: './assets/icon',
    name: 'Topside',
    executableName: 'Topside',
    appBundleId: 'com.topside.app',
    appCategoryType: 'public.app-category.productivity',
    overwrite: true,
    prune: true,

    // Build version must be incremented for each App Store Connect upload
    ...(isMAS ? { buildVersion: process.env.BUILD_VERSION || '1' } : {}),

    extendInfo: {
      NSMicrophoneUsageDescription: 'Topside needs microphone access to transcribe your speech.',
      NSScreenCaptureUsageDescription: 'Topside needs screen recording access to capture context from your active window.',
      ...(isMAS ? { ElectronTeamID: process.env.APPLE_TEAM_ID } : {}),
    },

    osxSign: isMAS ? {
      identity: 'Apple Distribution',
      platform: 'mas',
      type: 'distribution',
      provisioningProfile: './distribution.provisionprofile',
      optionsForFile: (filePath) => {
        // Main app bundle gets full entitlements; everything else inherits
        if (filePath.endsWith('.app')) {
          return {
            hardenedRuntime: false,
            entitlements: './entitlements.mas.plist',
          };
        }
        return {
          hardenedRuntime: false,
          entitlements: './entitlements.mas.inherit.plist',
        };
      },
    } : {
      // Direct distribution signing (DMG/ZIP)
      ...(process.env.APPLE_ID ? {
        identity: 'Developer ID Application',
      } : {}),
      entitlements: './entitlements.mas.plist',
      'entitlements-inherit': './entitlements.mas.inherit.plist',
    },

    // Notarization is for direct distribution only — MAS goes through Apple's review
    ...(!isMAS && process.env.APPLE_ID ? {
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    } : {}),
  },
  makers: [
    // MAS: produces .pkg for App Store Connect upload
    {
      name: '@electron-forge/maker-pkg',
      platforms: ['mas'],
    },
    // Direct distribution
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'Topside',
        setupIcon: './assets/icon.ico',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        devContentSecurityPolicy: "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' blob:; connect-src 'self' data: blob:; worker-src 'self' blob:",
        port: 3001,
        loggerPort: 9002,
        devServer: {
          setupExitSignals: true,
          client: {
            reconnect: false,
          },
        },
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './renderer/overlay/index.html',
              js: './renderer/overlay/overlay.jsx',
              name: 'overlay_window',
              preload: {
                js: './preload.js',
              },
            },
            {
              html: './renderer/settings/index.html',
              js: './renderer/settings/settings.jsx',
              name: 'settings_window',
              preload: {
                js: './preload-settings.js',
              },
            },
            {
              html: './renderer/detail/index.html',
              js: './renderer/detail/detail.jsx',
              name: 'detail_window',
              preload: {
                js: './preload-detail.js',
              },
            },
          ],
        },
      },
    },
  ],
};
