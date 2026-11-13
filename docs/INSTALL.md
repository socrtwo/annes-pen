# Installing Anne's Pen

Every release on the [Releases](https://github.com/socrtwo/annes-pen/releases) page has a build for each platform, plus `SHA256SUMS.txt` to check the downloads. The builds are not signed with paid store certificates, so each system asks once whether to trust them. The steps are below.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `Annes-Pen-<v>-windows-x64-setup.exe` | Installer; per-user, no admin rights needed |
| Windows on ARM | `Annes-Pen-<v>-windows-arm64-setup.exe` | |
| Windows, either | `Annes-Pen-<v>-windows-setup.exe` | One installer for x64 and ARM (twice the size) |
| Windows, no install | `Annes-Pen-<v>-windows-portable.exe` | Runs from a USB stick or any folder |
| macOS 11+ | `Annes-Pen-<v>-mac-universal.dmg` (or `.zip`) | One app for Apple silicon and Intel |
| Linux x64 | `Annes-Pen-<v>-linux-x86_64.AppImage` or `Annes-Pen-<v>-linux-amd64.deb` | |
| Raspberry Pi OS 64-bit (Pi 3/4/5) | `Annes-Pen-<v>-linux-arm64.deb` or `Annes-Pen-<v>-linux-arm64.AppImage` | |
| Raspberry Pi OS 32-bit | `Annes-Pen-<v>-linux-armv7l.deb` | Pi 2 and later. A Pi 4 or 5 runs it much faster. |
| ChromeOS | APK, Linux `.deb`, or the web app | See below |
| Android 7+ | `Annes-Pen-<v>.apk` | |
| iOS / iPadOS 15+ | `Annes-Pen-<v>-ios-unsigned.ipa` | Must be signed with your Apple ID; see below |
| Web | `Annes-Pen-<v>-web.zip` | Static files for any web server |

## Windows

Run the setup file. SmartScreen may say "Windows protected your PC": choose **More info ▸ Run anyway**. The warning appears because the installer is not signed with a paid code-signing certificate. Documents (.docx, .odt, .rtf, .doc) get **Open with ▸ Anne's Pen**.

## macOS

Open the `.dmg` and drag Anne's Pen to Applications. The app has an ad-hoc signature but is not notarized by Apple. So the first time, **right-click (or Control-click) the app ▸ Open ▸ Open**. On macOS 15 and later, you may instead need to go to **System Settings ▸ Privacy & Security ▸ Open Anyway** after the first attempt. If macOS reports the app as "damaged", run this once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Anne's Pen.app"
```

## Linux and Raspberry Pi OS

`.deb` (Debian, Ubuntu, Mint, Raspberry Pi OS):

```bash
sudo apt install ./Annes-Pen-<v>-linux-arm64.deb     # or -amd64 / -armv7l
```

Anne's Pen then appears in the Office menu. To remove it: `sudo apt remove quillpen`.

AppImage (any distribution, no install):

```bash
chmod +x Annes-Pen-<v>-linux-x86_64.AppImage
./Annes-Pen-<v>-linux-x86_64.AppImage
```

Some distributions need `libfuse2` (`sudo apt install libfuse2`) for AppImages. On Ubuntu 24.04 and later, AppImages may also need `--no-sandbox` because of an AppArmor restriction. The `.deb` does not have that problem.

## ChromeOS

Pick one:

1. **Android app**: on Chromebooks with Google Play, install the APK (it requires Android app sideloading or developer mode) or use the Play Store build when it is published.
2. **Linux app**: turn on **Settings ▸ Advanced ▸ Developers ▸ Linux development environment**. Then double-click the `.deb` in the Files app: use `amd64` on Intel/AMD Chromebooks and `arm64` on ARM Chromebooks.
3. **Web app**: open a hosted copy of Anne's Pen in Chrome, then **⋮ ▸ Cast, save and share ▸ Install page as app**. It then works offline and opens .docx files from the Files app.

## Android

Download the `.apk` and open it. Allow "Install unknown apps" for your browser or file manager when asked. To build the APK on the phone itself, see [BUILD.md](BUILD.md#android-on-the-device-termux).

## iOS and iPadOS

Apple only allows apps from the App Store or apps signed for your own devices. The `.ipa` in the release is unsigned. Sign it with your Apple ID using one of these:

- **Sideloadly** or **AltStore** (Windows/macOS): drag in the `.ipa` and sign in with your Apple ID. A free Apple ID signs for 7 days at a time; a paid developer account signs for a year.
- **Xcode** (macOS): build from source with `npm run ios:sync`, open `ios/App/App.xcodeproj`, pick your team under *Signing & Capabilities*, and run on your device.

On iOS, **Save** writes to **Files ▸ On My iPhone ▸ Anne's Pen**, and **Open** uses the system document picker. **Share** offers the share sheet. The iOS build uses the web versions of these functions; Android has a native plugin with more features (writing back to a file opened from another app, printing through the system service).

## Web

Unzip `Annes-Pen-<v>-web.zip` (its files are at the top level, with no folder) onto any static web host (GitHub Pages, Netlify, an Apache or nginx folder). Served over HTTPS, the app works offline after the first visit and can be installed as an app from Chrome or Edge. It does not need a server-side component.

To try it locally:

```bash
unzip -d annes-pen-web Annes-Pen-<v>-web.zip
npx serve annes-pen-web
```

## Coming from QuillForge

Anne's Pen was named QuillForge. Its `.qfd` and `.qfde` documents open in Anne's Pen.

- **Windows, macOS, Linux:** the desktop app copies QuillForge's settings, drafts, granted files and
  stored keys on its first start; nothing to do.
- **Web:** a copy served from the same address keeps its settings and drafts.
- **Android and iOS:** Anne's Pen is a new app with its own app ID, so it starts empty and the old
  QuillForge app stays installed next to it. To move over:
  1. In QuillForge, save every open document and draft you want to keep to a file (**File ▸ Save As**,
     somewhere you can reach from other apps, for example *Documents* or Google Drive).
  2. In QuillForge, open **File ▸ Options ▸ Export / Import All Settings…** (or **Backstage ▸ Options ▸
     Export / Import Settings…**), choose **Copy**, and paste the text somewhere safe (a note or a file).
     It holds the Quick Access Bar, custom tabs, shortcuts, macros, building blocks, AutoCorrect and
     preferences.
  3. Install Anne's Pen, open the same dialog, paste the text and choose **Import**.
  4. Open the saved documents in Anne's Pen (**File ▸ Open**, or *Open with* from a file manager).
  5. AI keys are not part of the settings text: enter them again in **AI ▸ AI Settings**. Downloaded
     spelling dictionaries download again from **Review ▸ Spelling Dictionaries**.
  6. Uninstall QuillForge when everything is there.

## Spelling dictionaries for other languages

The app includes English (American, British, Canadian, Australian). **Review ▸ Spelling Dictionaries** downloads any of 88 other languages and varieties when you need them; see the [README](../README.md#spelling-in-other-languages).
