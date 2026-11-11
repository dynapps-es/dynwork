### Install

| System                     | File                            |
| -------------------------- | ------------------------------- |
| macOS, Apple Silicon (M1+) | `dynwork-desktop-mac-arm64.dmg` |
| macOS, Intel               | `dynwork-desktop-mac-x64.dmg`   |
| Windows 10 and 11, x64     | `dynwork-desktop-win-x64.exe`   |

- **macOS:** open the DMG and drag Dynwork to Applications. The first launch says Apple could not verify it: open
  System Settings → Privacy & Security and choose **Open Anyway**. If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/Dynwork.app` in Terminal and open it again.
- **Windows:** run the installer. SmartScreen says Windows protected your PC: choose **More info** → **Run anyway**. It
  installs for your user only, with no administrator rights.
