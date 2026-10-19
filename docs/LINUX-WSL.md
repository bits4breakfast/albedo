# Running Albedo on Windows, under WSL2

Albedo has no native Windows build. Its pty bridge spawns a POSIX login shell
and its path checks assume POSIX paths (see `docs/TODO.md` §2b), so on Windows
it runs as a **Linux app inside WSL2**, next to the Claude Code you already run
there. WSLg puts its window on the Windows desktop.

Everything below happens inside the WSL shell (Ubuntu 22.04 or newer), not in
PowerShell.

## The one hard rule

**Your repos and `~/.claude/projects` must live on the WSL filesystem** (under
`/home/<you>/...`), never on `/mnt/c/...`.

Albedo learns about new transcript lines from filesystem change events, and
the Windows drives mounted through 9P do not reliably deliver them. Since TODO
§1 the watcher falls back to polling every 30 s and a banner says so -- so it
no longer fails silently -- but status, the waiting-on-you card and the
transcript then lag by up to that much, and git on `/mnt/c` is slow besides.
Clone into `~`, and run `claude` from there, so `~/.claude` is the WSL one.

## Option A: download a build from CI

GitHub Actions builds a `.deb` and an `.AppImage` on demand. Open the
repository's **Actions** tab, choose **CI**, then **Run workflow** on `main`.
When the run is green, download its `albedo-linux` artifact (a zip). Inside
WSL:

```sh
unzip albedo-linux.zip
sudo apt install ./deb/Albedo_*_amd64.deb   # installs `albedo` on PATH
albedo
```

The AppImage needs no install (`chmod +x Albedo_*.AppImage && ./Albedo_*.AppImage`)
but does need `sudo apt install libfuse2`.

## Option B: build it yourself

### Prerequisites

```sh
# Tauri's Linux dependencies (WebKitGTK 4.1)
sudo apt update
sudo apt install -y build-essential curl wget file git patchelf \
  libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev libxdo-dev \
  libayatana-appindicator3-dev librsvg2-dev

# Node 22 or newer (a test dependency, better-sqlite3, requires it). Any
# installer works; nvm shown here.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l
nvm install 22

# Rust, stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
exec $SHELL -l
```

Optional: `gh` (`sudo apt install gh`, then `gh auth login`) for the PR badge
on tasks, and `xdg-utils` for opening links. To send links to the Windows
browser rather than a Linux one, `sudo apt install wslu` and
`export BROWSER=wslview` in your profile (untested here).

### Build

```sh
cd ~
git clone <repo-url> albedo
cd albedo
npm ci

npm run tauri dev                                   # run from source, hot reload
# or
./build.sh --install                                # checks, release build, install the .deb
```

`./build.sh` stops with the exact `apt-get` command if a library is missing, and
warns if the checkout is under `/mnt/c`. Without `--install` it only builds.

A release build lands in `src-tauri/target/release/`:

- `albedo` -- the binary itself, runnable directly
- `bundle/deb/Albedo_<version>_amd64.deb`
- `bundle/appimage/Albedo_<version>_amd64.AppImage`

## Before the first launch

- `claude` must work in a WSL terminal on its own (installed and logged in).
  Albedo starts it through your **login shell** (`$SHELL -l -i`), so whatever
  your `~/.bashrc` / `~/.profile` puts on PATH is what it finds.
- Albedo strips `ANTHROPIC_API_KEY` from every session it spawns, so the
  subscription login is what gets used.

## If the window is blank

**Reported, untested here:** WebKitGTK under WSLg is widely reported to draw
an empty or black window unless its DMA-BUF renderer is turned off:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 albedo
# or, from source
WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

If that fixes it, export it from your profile. Nobody on the team has run
Albedo under WSLg yet; if you are first, what you find is worth writing back
into this file.

## Differences from macOS

- The window has the normal Linux title bar; the header no longer reserves
  space for the macOS stoplights.
- Links open with `xdg-open` instead of `open`.
