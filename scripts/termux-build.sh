#!/data/data/com.termux/files/usr/bin/bash
# Build the Anne's Pen Android APK on an Android device with Termux (https://termux.dev, the
# F-Droid or GitHub build; the Play Store build is outdated).
#
#   curl -fsSLO https://raw.githubusercontent.com/socrtwo/annes-pen/main/scripts/termux-build.sh
#   bash termux-build.sh            # first run installs everything (about 2.5 GB, 20-40 minutes)
#   bash termux-build.sh --web      # only the web build (dist/), no Android SDK needed
#
# Environment overrides: QF_DIR (checkout, default ~/annes-pen, or ~/QuillPen if an older run made it), QF_BRANCH (default main),
# ANDROID_HOME (default ~/android-sdk), QF_HEAP (Gradle heap, default 1536m).
#
# Google's Android SDK has no ARM build of aapt2, so the build uses Termux's own aapt2 via
# android.aapt2FromMavenOverride. Needs a 64-bit ARM device with about 4 GB of RAM.
set -euo pipefail

if [[ -z "${QF_DIR:-}" && ! -d "$HOME/annes-pen" && -d "$HOME/QuillPen/.git" ]]; then QF_DIR="$HOME/QuillPen"; fi # rename:keep — checkout made before the rename
QF_DIR="${QF_DIR:-$HOME/annes-pen}"
QF_BRANCH="${QF_BRANCH:-main}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
QF_HEAP="${QF_HEAP:-1536m}"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-13114758_latest.zip"
WEB_ONLY=0
[[ "${1:-}" == "--web" ]] && WEB_ONLY=1

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

say "Installing Termux packages"
pkg update -y
pkg install -y git nodejs-lts unzip wget zip
if [[ $WEB_ONLY == 0 ]]; then
  pkg install -y openjdk-21 aapt aapt2 || pkg install -y openjdk-21 aapt
fi

say "Getting the source ($QF_BRANCH)"
if [[ -d "$QF_DIR/.git" ]]; then
  git -C "$QF_DIR" fetch --depth 1 origin "$QF_BRANCH"
  git -C "$QF_DIR" checkout -q FETCH_HEAD
else
  git clone --depth 1 --branch "$QF_BRANCH" https://github.com/socrtwo/annes-pen "$QF_DIR"
fi
cd "$QF_DIR"

say "Installing JavaScript dependencies"
# The desktop (Electron) and browser-test packages are not needed here.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm ci --no-audit --no-fund

say "Building the web app"
npm run build
if [[ $WEB_ONLY == 1 ]]; then
  say "Done: web build in $QF_DIR/dist (serve it with: npx vite preview --host)"
  exit 0
fi

if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  say "Installing the Android SDK command-line tools"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  wget -q --show-progress -O "$TMPDIR/cmdline-tools.zip" "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest" "$ANDROID_HOME/cmdline-tools/cmdline-tools"
  unzip -q "$TMPDIR/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -f "$TMPDIR/cmdline-tools.zip"
fi
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$PREFIX/lib/jvm/java-21-openjdk}"

say "Installing SDK platform 36 and build tools"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses > /dev/null || true
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" "platforms;android-36" "build-tools;36.0.0"

say "Preparing the Android project"
npx cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

say "Building the APK (Gradle downloads itself the first time)"
cd android
chmod +x gradlew
# Without a release keystore (ANDROID_KEYSTORE_PATH etc., docs/ANDROID.md) sign with the debug key.
if [[ -z "${ANDROID_KEYSTORE_PATH:-}" ]]; then export ALLOW_DEBUG_SIGNING=true; fi
./gradlew --no-daemon \
  -Dorg.gradle.jvmargs="-Xmx$QF_HEAP -Dfile.encoding=UTF-8" \
  -Pandroid.aapt2FromMavenOverride="$PREFIX/bin/aapt2" \
  assembleRelease

VERSION=$(node -p "require('../package.json').version")
APK=$(ls app/build/outputs/apk/release/*.apk | head -n 1)
OUT="$QF_DIR/Annes-Pen-$VERSION.apk"
cp "$APK" "$OUT"
if [[ -d "$HOME/storage/downloads" ]]; then
  cp "$OUT" "$HOME/storage/downloads/"
  say "Done: $OUT (also copied to Downloads). Open it with a file manager to install."
else
  say "Done: $OUT. Run termux-setup-storage once to let the script copy it to Downloads."
fi
