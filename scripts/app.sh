#!/bin/sh
# Builds the menu bar app (D26) into app/build/minitart.app, and zips it.
#
#   scripts/app.sh [version]
#
# With APP_SIGN_IDENTITY set (a Developer ID Application identity in the keychain), it is
# signed for distribution, with the hardened runtime notarization asks for. Without it, it is
# signed for this Mac only, to run while working on it.
set -eu

version=${1:-0.0.0}
root=$(cd "$(dirname "$0")/.." && pwd)
app="$root/app/build/minitart.app"

cd "$root/app"
swift build -c release --arch arm64
binary="$(swift build -c release --arch arm64 --show-bin-path)/minitart-app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/minitart-app"
cp "$root/app/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>sh.rovira.minitart.app</string>
  <key>CFBundleName</key><string>minitart</string>
  <key>CFBundleDisplayName</key><string>minitart</string>
  <key>CFBundleExecutable</key><string>minitart-app</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- In the menu bar only: no Dock icon, no app menu. -->
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>minitart, MIT licence</string>
</dict>
</plist>
PLIST

if [ -n "${APP_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$APP_SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app"
fi
codesign --verify --strict "$app"

(cd "$root/app/build" && rm -f "minitart-app-$version.zip" && ditto -c -k --keepParent minitart.app "minitart-app-$version.zip")
echo "$root/app/build/minitart-app-$version.zip"
