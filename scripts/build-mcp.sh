#!/usr/bin/env bash
# Build Albedo's MCP server (src-tauri/mcp, #157) and put it where Tauri
# bundles a sidecar from: src-tauri/binaries/albedo-mcp-<target triple>.
#
#   scripts/build-mcp.sh     release build, then copy
#
# build.sh runs it on every build and passes
#   --config '{"bundle":{"externalBin":["binaries/albedo-mcp"]}}'
# so the server lands beside Albedo's own binary inside the app, where
# src-tauri/src/mcp.rs looks for it. It is not optional the way PHPantom is:
# it is a few hundred KB, built from this repository, and downloads nothing.

set -euo pipefail

cd "$(dirname "$0")/.."

triple=$(rustc -vV | sed -n 's/^host: //p')
[ -n "$triple" ] || { echo "could not read the Rust host triple from rustc -vV" >&2; exit 1; }

cargo build --release --manifest-path src-tauri/Cargo.toml -p albedo-mcp

ext=""
case "$triple" in *windows*) ext=".exe" ;; esac
mkdir -p src-tauri/binaries
cp "src-tauri/target/release/albedo-mcp$ext" "src-tauri/binaries/albedo-mcp-$triple$ext"
echo "src-tauri/binaries/albedo-mcp-$triple$ext"
