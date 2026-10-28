#!/bin/sh
# Copies the browser side of the game (HTML, CSS, JS, audio) from ../public into laravel/public.
# The Laravel app serves the very same files as the Node server; run this after changing anything in ../public.
# Files that only the Laravel app changes (the operator's own site: sign-in link on the game page, the cashier tab in the console) are kept.
cd "$(dirname "$0")/.." || exit 1
KEEP="js/bet.js js/admin.js"
for f in index.html controller.html backoffice.html admin.html manifest.webmanifest; do cp "../public/$f" "public/$f"; done
for d in css js audio; do
  mkdir -p "public/$d"
  (cd "../public/$d" && find . -type f) | while read -r f; do
    f="${f#./}"
    case " $KEEP " in *" $d/$f "*) continue;; esac
    mkdir -p "$(dirname "public/$d/$f")"; cp "../public/$d/$f" "public/$d/$f"
  done
done
echo "frontend copied from ../public (kept: $KEEP)"
