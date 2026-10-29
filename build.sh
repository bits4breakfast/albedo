#!/usr/bin/env bash
# Build Albedo for this machine.
#
#   ./build.sh                 checks + release build (.app/.dmg on macOS, .deb/.AppImage on Linux)
#   ./build.sh --skip-checks   build only (no typecheck, no tests)
#   ./build.sh --install       also install it (macOS: /Applications; Linux: the .deb, via sudo apt)
#   ./build.sh --with-phpantom bundle PHPantom (~48 MB) for type-aware PHP navigation
#
# On Windows, run it inside WSL2 -- see docs/LINUX-WSL.md. Nothing here installs
# system packages on its own: a missing build prerequisite is reported with the
# exact command to run, and the script stops. Tools the app needs only at run
# time (claude, gh) are warned about, since the build itself does not use them.

set -euo pipefail

cd "$(dirname "$0")"

skip_checks=0
install=0
with_phpantom=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=1 ;;
    --install) install=1 ;;
    --with-phpantom) with_phpantom=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
warnings=()
warn() {
  printf 'warning: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '  %s\n' "${@:2}" >&2
  warnings+=("$1")
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

if [ "$os" = macos ]; then
  xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools are missing (Rust needs their linker)." \
    "Install them with: xcode-select --install"
fi

# git is needed by the tests as well as the app: worktrees, the Files panel,
# Quick Open and Find in Files all run it.
command -v git >/dev/null || fail "git is not installed." \
  "Install it (macOS: xcode-select --install; Linux: sudo apt-get install -y git), then re-run."

# --- what the app needs at run time --------------------------------------------
# Not needed to build, so a warning rather than a stop: you may be building for
# someone else's machine. Each is checked the way the app will look for it.

# Albedo starts claude through the user's login shell (-l -i, as pty.rs does),
# so that is where it has to be found -- not on this script's PATH.
if ! "${SHELL:-/bin/sh}" -l -i -c 'command -v claude' >/dev/null 2>&1 </dev/null; then
  warn "claude was not found by your login shell, so Albedo could not start any task." \
    "Install Claude Code (https://claude.com/claude-code) and make sure the shell profile" \
    "that sets your PATH (e.g. ~/.zprofile or ~/.zshrc) adds the folder it is installed in."
fi

if ! command -v gh >/dev/null; then
  warn "The GitHub CLI (gh) is not installed: pull requests will show no status." \
    "Install it from https://cli.github.com, then run: gh auth login"
elif ! gh auth status >/dev/null 2>&1; then
  warn "The GitHub CLI (gh) is not signed in: pull requests will show no status." \
    "Run: gh auth login"
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

# --- PHPantom (optional) --------------------------------------------------------
# Bundled as a Tauri sidecar: the binary sits next to Albedo's own inside the
# app, named with the target triple as Tauri requires. The externalBin entry is
# passed for this build only, so a build without the flag is unchanged and no
# config file has to be edited back. scripts/install-phpantom.sh does the
# pinned download and the checksum check.
tauri_config=()
if [ "$with_phpantom" -eq 1 ]; then
  step "Fetching PHPantom to bundle"
  triple=$(rustc -vV | sed -n 's/^host: //p')
  [ -n "$triple" ] || fail "could not read the Rust host triple from rustc -vV"
  scripts/install-phpantom.sh --to "src-tauri/binaries/phpantom_lsp-$triple"
  tauri_config=(--config '{"bundle":{"externalBin":["binaries/phpantom_lsp"]}}')
fi

# --- signing (macOS) -------------------------------------------------------------
# macOS refuses notifications to an ad-hoc signed app ("Notifications are not
# allowed for this application"), so without a real identity Albedo can bounce
# the dock but never show a banner. The cheapest real identity is a free Apple
# Development certificate. Tauri signs with whatever APPLE_SIGNING_IDENTITY
# names; one set by the caller wins.
signed=0
if [ "$os" = macos ]; then
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null |
      sed -nE 's/.*"((Apple Development|Developer ID Application): [^"]*)".*/\1/p' | head -n 1 || true)
  fi
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    export APPLE_SIGNING_IDENTITY
    signed=1
    echo "Signing as: $APPLE_SIGNING_IDENTITY"
  else
    warn "No signing certificate: Albedo will build ad-hoc signed, and macOS will not show its notifications." \
      "A free one comes with any Apple ID: Xcode > Settings > Accounts > Manage Certificates > + > Apple Development."
  fi
fi

# --- build ---------------------------------------------------------------------
step "Building release bundles: $bundles"
# Unquoted on purpose: bash 3.2 (macOS) with set -u needs this form to expand
# an empty array to nothing rather than to an empty argument.
npm run tauri build -- --bundles "$bundles" ${tauri_config[@]+"${tauri_config[@]}"}

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
    if [ "$signed" -eq 0 ]; then
      echo "Installed. The build is unsigned: the first launch may need right-click > Open."
    else
      echo "Installed."
    fi
  else
    deb=$(find "$bundle_dir/deb" -maxdepth 1 -name '*.deb' | head -n 1)
    [ -n "$deb" ] || fail "no .deb was produced"
    step "Installing $(basename "$deb") (sudo)"
    sudo apt-get install -y "./$deb"
    echo "Installed. If the window comes up blank under WSLg, see docs/LINUX-WSL.md."
  fi
fi

# Repeated at the end: the build output scrolls them out of sight.
if [ ${#warnings[@]} -gt 0 ]; then
  printf '\nBuilt, with %d warning(s) about this machine:\n' "${#warnings[@]}"
  printf '  - %s\n' "${warnings[@]}"
fi
