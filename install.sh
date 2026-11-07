#!/usr/bin/env bash
# Installs the Bubbles GNOME Shell extension in the user's extension folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="bubbles@Nicolas-Gth"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

rm -rf "$DEST"
mkdir -p "$DEST/schemas"
cp "$ROOT/metadata.json" "$ROOT/extension.js" "$ROOT/prefs.js" \
    "$ROOT/look.js" "$ROOT/physics.js" "$ROOT/bubbleEffect.js" "$ROOT/overlay.js" \
    "$ROOT/icon.png" "$ROOT/burst.js" "$DEST/"
cp "$ROOT/schemas/"*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"


# Translations: compile the catalogs into the extension's locale/ folder.
if command -v msgfmt >/dev/null 2>&1; then
    for po in "$ROOT"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        mkdir -p "$DEST/locale/$lang/LC_MESSAGES"
        msgfmt -o "$DEST/locale/$lang/LC_MESSAGES/bubbles.mo" "$po"
    done
elif [ -d "$ROOT/locale" ]; then
    cp -a "$ROOT/locale" "$DEST/"
fi

echo "Installed $UUID in $DEST"
echo
echo "On Wayland, log out and back in once so GNOME Shell discovers it, then:"
echo "  gnome-extensions enable $UUID"
echo "  gnome-extensions prefs $UUID"
echo
echo "Or open the Extensions app and enable 'Bubbles Screensaver'."
