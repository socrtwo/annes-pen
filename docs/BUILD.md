# Building Anne's Pen

All platforms share one web build (`npm run build` → `dist/`). Each platform wraps it:

| Platform | Wrapper | Command | Builds on |
|---|---|---|---|
| Web / PWA | none | `npm run build` | anything with Node 22 |
| Android | Capacitor + `QuillNativePlugin.java` | `npm run android:build` | Linux, macOS, Windows, or Android itself (Termux) |
| Windows, macOS, Linux, Raspberry Pi OS | Electron (`electron/`) | `npm run desktop:dist` | the target OS (macOS builds need a Mac) |
| iOS / iPadOS | Capacitor (`ios/`) | `npm run ios:sync`, then Xcode | macOS with Xcode |

**Releases:** see [Releases](#releases) below.

## Prerequisites

- Node.js 22.12 or later (`node -v`; `.nvmrc` says 22), then `npm ci` in the repository.
- Android: JDK 21 and the Android SDK (platform 36, build-tools 36.0.0).
- iOS: Xcode 16 or later.

## Web

```bash
npm ci
npm run build        # dist/ (also writes public/third-party-notices.txt)
npx vite preview     # http://localhost:4173
```

## Desktop (Windows, macOS, Linux, Raspberry Pi OS)

```bash
npm run desktop        # build and run the desktop app
npm run desktop:dist   # build installers for this OS into release/
```

`desktop:dist` builds what the current OS can make:
- Windows: the NSIS installers (x64, arm64) and the portable `.exe`.
- macOS: a universal `.dmg` and `.zip`.
- Linux: an AppImage and a `.deb` for x64, arm64 and armv7l (Raspberry Pi OS 32-bit).

For one target only:

```bash
npm run build && node scripts/prepare-desktop.mjs
npx electron-builder --config electron-builder.config.cjs --linux deb --arm64
```

To run the desktop test (on a Linux server, under a virtual display):

```bash
xvfb-run -a node tests/e2e/desktop.mjs
```

## Tests

```bash
npm test             # unit tests (vitest)
npm run e2e          # build, serve with vite preview on a free port, run the smoke test
npm run e2e:all      # the same with smoke, ui-hardening, all-commands, io, visual and offline (PWA)
npm run e2e:smoke    # one test against the existing dist/ (also e2e:ui-hardening, e2e:all-commands,
                     # e2e:io, e2e:visual, e2e:offline, e2e:ai, e2e:dictionaries, e2e:legacy)
npm run e2e:layout   # phone layouts (starts its own dev server)
```

`scripts/run-e2e.mjs` runs any of `tests/e2e/*.mjs` by name, or against a running server with
`QF_URL=http://localhost:4173/`. The tests use Playwright's Chromium (`npx playwright install chromium`);
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` points them at another Chromium build. CI (`.github/workflows/ci.yml`)
runs the unit tests and the smoke, ui-hardening, offline and all-commands browser tests on every push
and pull request.

## Android on a computer

```bash
npm run android:build    # build, cap sync, gradlew assembleRelease
```

The APK is in `android/app/build/outputs/apk/release/`. A release build needs the release keystore; without one, set `ALLOW_DEBUG_SIGNING=true` to sign it with the debug key (testing and sideloading only). [ANDROID.md](ANDROID.md) covers signing for Google Play.

## Android on the device (Termux)

You can build the APK on a 64-bit ARM phone or tablet with 4 GB of RAM or more, using [Termux](https://termux.dev) from F-Droid or GitHub (the Play Store version is outdated). The script installs Node.js, OpenJDK 21, the Android SDK command-line tools and Termux's ARM build of `aapt2`. It then clones the repository and builds the APK. The first run downloads about 2.5 GB and takes 20–40 minutes.

```bash
pkg install -y curl
termux-setup-storage        # optional: lets the script copy the APK to Downloads
curl -fsSLO https://raw.githubusercontent.com/socrtwo/annes-pen/main/scripts/termux-build.sh
bash termux-build.sh
```

Options (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `QF_BRANCH` | `main` | Branch to build |
| `QF_DIR` | `~/annes-pen` (an existing `~/QuillPen` checkout from an older run is reused) | Checkout folder |
| `ANDROID_HOME` | `~/android-sdk` | SDK folder |
| `QF_HEAP` | `1536m` | Gradle heap; lower it (`1024m`) if the build is killed for memory |

`bash termux-build.sh --web` builds only the web app, without the SDK.

The manual steps the script performs, if you prefer to run them yourself:

```bash
pkg update -y && pkg install -y git nodejs-lts openjdk-21 aapt aapt2 unzip wget zip
git clone --depth 1 https://github.com/socrtwo/annes-pen && cd annes-pen
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run build
mkdir -p ~/android-sdk/cmdline-tools && cd ~/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
unzip commandlinetools-linux-*_latest.zip && mv cmdline-tools latest && cd ~/annes-pen
export ANDROID_HOME=~/android-sdk JAVA_HOME=$PREFIX/lib/jvm/java-21-openjdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0"
npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ALLOW_DEBUG_SIGNING=true ./gradlew --no-daemon -Dorg.gradle.jvmargs=-Xmx1536m \
  -Pandroid.aapt2FromMavenOverride=$PREFIX/bin/aapt2 assembleRelease
```

The APK is then in `android/app/build/outputs/apk/release/`.

Why the extra steps: Google's SDK ships `aapt2` only for x86-64 desktops, so the build uses Termux's ARM `aapt2` through `android.aapt2FromMavenOverride`. Electron and Playwright are skipped because they are for desktop builds and browser tests. If Gradle fails on an `aapt2` version mismatch after a Termux update, run `pkg upgrade aapt2` (or `pkg upgrade aapt`) and try again.

**Untested:** the Termux route has not been run on a physical device by the project; CI builds the APK on Linux. Please report problems in the issue tracker.

## iOS

```bash
npm run ios:sync                      # web build + copy into ios/App/App/public
open ios/App/App.xcodeproj            # in Xcode: Signing & Capabilities ▸ Team, then Run
```

CI builds an unsigned `.ipa` with:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -sdk iphoneos \
  CODE_SIGNING_ALLOWED=NO build
```

## Releases

`.github/workflows/release.yml` builds every platform and publishes them as one GitHub release. It
runs for:

- **a tag** `v<version>` pushed to GitHub: `git tag v0.5.0 && git push origin v0.5.0`. The tag must be
  `v` followed by the `version` in `package.json` (the run fails otherwise). `v<version>-<suffix>`
  (for example `v0.6.0-beta.1`) publishes a prerelease. Only an official `v<version>` tag becomes the
  repository's *latest* release.
- **a manual run** (Actions tab ▸ Release ▸ Run workflow) on the default branch (`main`; other
  branches are refused). Give a tag (for example `v0.5.0`, for sessions that can push branches but not
  tags) or leave it empty for a prerelease `v<version>-build.<run number>`. The *prerelease* box applies
  to an official tag.
- **a commit on `main`** whose message contains `[release]`: a prerelease `v<version>-build.<run number>`.

A run fails if the release already exists (re-running the same run may finish it). Android release
builds are signed with the keystore from the repository secrets (see [ANDROID.md](ANDROID.md#signing));
without it the Android build fails and the release lists it as not built.

The publishing job uses the GitHub environment **`release`**. Create it once in the repository's
*Settings ▸ Environments ▸ New environment* (name `release`), add *Required reviewers*, and limit
*Deployment branches and tags* to `main` and `v*` tags, so every release waits for approval. Without
that setup GitHub creates the environment on the first run with no protection.

Test builds of the Android app alone: [ANDROID.md](ANDROID.md#continuous-integration-and-releases).
Actions are pinned to commit SHAs; `.github/dependabot.yml` proposes updates weekly.

## Icons

`npm run icons` regenerates the Android launcher icons and the desktop, iOS and web-app PNGs from `resources/icon.svg`, `resources/icon-foreground.svg` and `resources/icon-background.txt` (see docs/ANDROID.md, *App icon*).

## Spelling dictionary catalog

`node scripts/gen-dictionary-catalog.mjs` refreshes `src/proof/dictionary-catalog.json` from the npm registry. For each language it records the version, license, checksums, and the measured load time and memory.
