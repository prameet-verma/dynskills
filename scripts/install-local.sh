#!/bin/sh
# Install dynskills (Dynamic Skills) from this checkout into a local path (no npm registry publish needed).
#
#   sh scripts/install-local.sh              # build, pack, install, link `dynskills` into ~/.local/bin
#   sh scripts/install-local.sh --uninstall  # remove the install and the link (only if they are ours)
#
# Layout (override with env vars):
#   DYNAMIC_SKILLS_HOME     install root        (default: ~/.local/share/dynskills)
#   DYNAMIC_SKILLS_BIN_DIR  directory to link   (default: ~/.local/bin; should be on PATH)
#   NODE                    Node.js >= 26 binary (default: the `node` on PATH)
#
# The installed command runs with the Node binary recorded at install time, so it keeps working
# when a shell or harness session defaults to an older Node.
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
PREFIX=${DYNAMIC_SKILLS_HOME:-"$HOME/.local/share/dynskills"}
BIN_DIR=${DYNAMIC_SKILLS_BIN_DIR:-"$HOME/.local/bin"}
LINK="$BIN_DIR/dynskills"
ALIAS="$BIN_DIR/dynamic-skills"
SHIM="$PREFIX/bin/dynskills"
MARKER="dynskills local install"

is_ours() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$SHIM" ]
}

if [ "${1:-}" = "--uninstall" ]; then
  for l in "$LINK" "$ALIAS"; do if is_ours "$l"; then rm -f "$l"; echo "removed $l"; fi; done
  if [ -f "$SHIM" ] && grep -q "$MARKER" "$SHIM"; then rm -rf "$PREFIX"; echo "removed $PREFIX"; fi
  exit 0
fi

NODE_BIN=${NODE:-$(command -v node || true)}
[ -n "$NODE_BIN" ] || { echo "install-local: node not found (set NODE=/path/to/node >= 26)" >&2; exit 1; }
NODE_BIN=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd -P)/$(basename -- "$NODE_BIN")
MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 26 ] || { echo "install-local: $NODE_BIN is Node $MAJOR; Dynamic Skills needs Node >= 26 (set NODE=...)" >&2; exit 1; }
NPM_BIN="$(dirname -- "$NODE_BIN")/npm"
[ -x "$NPM_BIN" ] || NPM_BIN=npm

for l in "$LINK" "$ALIAS"; do
  if [ -e "$l" ] && ! is_ours "$l"; then
    echo "install-local: $l exists and is not a dynskills link; refusing to replace it" >&2
    exit 1
  fi
done

echo "building $REPO"
(cd "$REPO" && PATH="$(dirname -- "$NODE_BIN"):$PATH" "$NODE_BIN" node_modules/typescript7/bin/tsc -p tsconfig.build.json)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
TGZ=$(cd "$REPO" && PATH="$(dirname -- "$NODE_BIN"):$PATH" "$NPM_BIN" pack --silent --pack-destination "$STAGE")

echo "installing into $PREFIX"
rm -rf "$PREFIX/app"
mkdir -p "$PREFIX/app" "$PREFIX/bin" "$BIN_DIR"
PATH="$(dirname -- "$NODE_BIN"):$PATH" "$NPM_BIN" install --prefix "$PREFIX/app" --omit=dev --no-audit --no-fund --silent "$STAGE/$TGZ"

CLI="$PREFIX/app/node_modules/dynskills/dist/cli/index.js"
[ -f "$CLI" ] || { echo "install-local: $CLI missing after install" >&2; exit 1; }
cat > "$SHIM" <<EOF
#!/bin/sh
# $MARKER (from $REPO)
exec "$NODE_BIN" "$CLI" "\$@"
EOF
chmod 755 "$SHIM"
ln -sf "$SHIM" "$LINK"
ln -sf "$SHIM" "$ALIAS"

echo "linked $LINK (and alias $ALIAS) -> $SHIM"
"$LINK" --version
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not on PATH; add it, or set DYNAMIC_SKILLS_BIN=$SHIM for the Claude Code plugin launcher" ;;
esac
