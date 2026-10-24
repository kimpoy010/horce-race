#!/bin/sh
# Copies the browser side of the game (HTML, CSS, JS, audio) from ../public into laravel/public.
# The Laravel app serves the very same files as the Node server; run this after changing anything in ../public.
cd "$(dirname "$0")/.." || exit 1
for f in index.html controller.html backoffice.html admin.html manifest.webmanifest; do cp "../public/$f" "public/$f"; done
for d in css js audio; do mkdir -p "public/$d"; cp -R "../public/$d/." "public/$d/"; done
echo "frontend copied from ../public"
