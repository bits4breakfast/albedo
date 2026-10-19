#!/usr/bin/env bash
# Build Albedo for this machine.
#
#   ./build.sh                 checks + release build (.app/.dmg on macOS, .deb/.AppImage on Linux)
#   ./build.sh --skip-checks   build only (no typecheck, no tests)
#   ./build.sh --install       also install it (macOS: /Applications; Linux: the .deb, via sudo apt)
#
# On Windows, run it inside WSL2 -- see docs/LINUX-WSL.md. Nothing here installs
# system packages on its own: a missing prerequisite is reported with the exact
# command to run, and the script stops.

set -euo pipefail

cd "$(dirname "$0")"

skip_checks=0
install=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=1 ;;
    --install) install=1 ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nerror: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "${@:2}" >&2
  exit 1
}

# --- platform ----------------------------------------------------------------
case "$(uname -s)" in
  Darwin)
    os=macos
    bundles=app,dmg
    ;;
  Linux)
    os=linux
    bundles=deb,appimage
    ;;
  *) fail "unsupported platform: $(uname -s)" "On Windows, run this inside WSL2 (docs/LINUX-WSL.md)." ;;
esac

# --- prerequisites -------------------------------------------------------------
step "Checking prerequisites ($os)"

command -v node >/dev/null || fail "Node.js is not installed." "Install Node 22 or newer (e.g. via nvm), then re-run."
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || fail "Node $node_major found; Node 22 or newer is required (better-sqlite3 needs it)."

# rustup installs into ~/.cargo; a fresh shell may not have it on PATH yet.
if ! command -v cargo >/dev/null && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
command -v cargo >/dev/null || fail "Rust is not installed." \
  "Install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

if [ "$os" = linux ]; then
  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    fail "Tauri's Linux libraries are missing." "Install them with:" \
      "  sudo apt-get update && sudo apt-get install -y build-essential pkg-config curl wget file patchelf \\" \
      "    libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev libfuse2"
  fi
  # A repo on the Windows drive works badly: file watching does not cross /mnt/c.
  case "$PWD" in
    /mnt/*) echo "warning: this checkout is under $PWD. Clone it inside the WSL filesystem (e.g. ~/) instead -- see docs/LINUX-WSL.md." >&2 ;;
  esac
fi

echo "node $(node -v), $(cargo --version)"

# --- dependencies --------------------------------------------------------------
# npm ci only when needed: it deletes node_modules, which is slow and pointless
# when the lockfile has not changed since the last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  step "Installing npm dependencies"
  npm ci
fi

# --- checks --------------------------------------------------------------------
if [ "$skip_checks" -eq 0 ]; then
  step "Typecheck"
  npm run --silent typecheck
  step "Tests"
  npx vitest run
fi

# --- build ---------------------------------------------------------------------
step "Building release bundles: $bundles"
npm run tauri build -- --bundles "$bundles"

bundle_dir=src-tauri/target/release/bundle
step "Built"
find "$bundle_dir" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \) -print

# --- install -------------------------------------------------------------------
if [ "$install" -eq 1 ]; then
  if [ "$os" = macos ]; then
    app=$(find "$bundle_dir/macos" -maxdepth 1 -name '*.app' | head -n 1)
    [ -n "$app" ] || fail "no .app was produced"
    if pgrep -xq Albedo; then
      fail "Albedo is running. Quit it, then re-run with --install (the build is already done; add --skip-checks)."
    fi
    step "Installing $(basename "$app") into /Applications"
    rm -rf "/Applications/$(basename "$app")"
    cp -R "$app" /Applications/
    echo "Installed. The build is unsigned: the first launch may need right-click > Open."
  else
    deb=$(find "$bundle_dir/deb" -maxdepth 1 -name '*.deb' | head -n 1)
    [ -n "$deb" ] || fail "no .deb was produced"
    step "Installing $(basename "$deb") (sudo)"
    sudo apt-get install -y "./$deb"
    echo "Installed. If the window comes up blank under WSLg, see docs/LINUX-WSL.md."
  fi
fi
