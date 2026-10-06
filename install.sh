#!/usr/bin/env bash
# Installs wifi-hotspot to /usr/local/bin and creates your settings file.
#   ./install.sh             install the CLI
#   ./install.sh --gui       install the CLI and the GTK4 GUI
#   ./install.sh --gnome     install the CLI, the GUI and the GNOME Shell Quick Settings toggle
#   ./install.sh --uninstall remove (keeps your settings)
set -euo pipefail
cd "$(dirname "$0")"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wifi-hotspot"
EXT_UUID=wifi-hotspot@linux-mobile-hotspot
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"

# shell_ext_list add|remove <org.gnome.shell key> <uuid>. Edits the setting directly: while GNOME Shell
# runs, `gnome-extensions enable` refuses extensions that the shell has not loaded yet.
shell_ext_list() {
  local cur new
  cur=$(gsettings get org.gnome.shell "$2") || return 1
  new=$(python3 -c 'import ast, sys
op, cur, uuid = sys.argv[1:]
items = [x for x in ast.literal_eval(cur[4:] if cur.startswith("@as ") else cur) if x != uuid]
print(items + [uuid] if op == "add" else items)' "$1" "$cur" "$3") || return 1
  gsettings set org.gnome.shell "$2" "$new"
}

if [ "${1:-}" = --uninstall ]; then
  /usr/local/bin/wifi-hotspot stop 2>/dev/null || true
  if [ -d "$EXT_DIR" ]; then
    shell_ext_list remove enabled-extensions "$EXT_UUID" 2>/dev/null || true
    rm -rf "$EXT_DIR"
  fi
  sudo rm -f /usr/local/bin/wifi-hotspot /usr/local/bin/wifi-hotspot-gui \
    /usr/local/share/applications/wifi-hotspot-gui.desktop /etc/udev/rules.d/90-wifi-hotspot-unmanaged.rules
  sudo udevadm control --reload 2>/dev/null || true
  echo "Uninstalled. Your settings are still in $CONF_DIR (delete it if you want)."
  exit 0
fi

[ "$(id -u)" -eq 0 ] && { echo "Run as your normal user (not with sudo); it will ask for sudo when needed."; exit 1; }
case "${1:-}" in ""|--gui|--gnome) ;; *) echo "Unknown option: $1 (use --gui, --gnome or --uninstall)"; exit 1 ;; esac

# Install missing dependencies
need=()
for t in iw hostapd dnsmasq iptables; do command -v "$t" >/dev/null || need+=("$t"); done
if [ ${#need[@]} -gt 0 ]; then
  echo "Installing missing packages: ${need[*]}"
  if   command -v apt    >/dev/null; then sudo apt update && sudo apt install -y "${need[@]/#dnsmasq/dnsmasq-base}"  # dnsmasq-base: binary only, no system DNS service
  elif command -v dnf    >/dev/null; then sudo dnf install -y "${need[@]}"
  elif command -v pacman >/dev/null; then sudo pacman -S --needed --noconfirm "${need[@]}"
  elif command -v zypper >/dev/null; then sudo zypper install -y "${need[@]}"
  else echo "Please install manually: ${need[*]}"; exit 1; fi
fi


sudo install -m 755 wifi-hotspot /usr/local/bin/wifi-hotspot

if [ -n "${1:-}" ]; then
  if ! python3 -c 'import gi; gi.require_version("Gtk","4.0"); gi.require_version("Adw","1")' 2>/dev/null; then
    echo "Installing GTK4 / libadwaita Python bindings"
    if   command -v apt    >/dev/null; then sudo apt install -y python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 ieee-data
    elif command -v dnf    >/dev/null; then sudo dnf install -y python3-gobject gtk4 libadwaita hwdata
    elif command -v pacman >/dev/null; then sudo pacman -S --needed --noconfirm python-gobject gtk4 libadwaita hwdata
    elif command -v zypper >/dev/null; then sudo zypper install -y python3-gobject typelib-1_0-Gtk-4_0 typelib-1_0-Adw-1 hwdata
    else echo "Install PyGObject, GTK 4 and libadwaita manually"; exit 1; fi
  fi
  sudo install -m 755 wifi-hotspot-gui /usr/local/bin/wifi-hotspot-gui
  sudo install -Dm 644 wifi-hotspot-gui.desktop /usr/local/share/applications/wifi-hotspot-gui.desktop
  echo "GUI installed: launch 'Wi-Fi Hotspot' from the app menu or run wifi-hotspot-gui"
fi

if [ "${1:-}" = --gnome ]; then
  shell_major=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)
  if [ -z "$shell_major" ] || [ "$shell_major" -lt 45 ]; then
    echo "Quick Settings toggle skipped: it needs GNOME Shell 45 or newer (found: ${shell_major:-none})."
  else
    mkdir -p "$EXT_DIR"
    install -m 644 gnome-extension/metadata.json gnome-extension/extension.js gnome-extension/stylesheet.css "$EXT_DIR/"
    { shell_ext_list remove disabled-extensions "$EXT_UUID" && shell_ext_list add enabled-extensions "$EXT_UUID"; } ||
      echo "Could not enable it; after logging in again run: gnome-extensions enable $EXT_UUID"
    echo "Quick Settings toggle installed. Log out and back in to load it (GNOME on Wayland cannot reload the shell)."
  fi
fi

mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
if [ ! -f "$CONF_DIR/settings" ]; then
  pw=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  (umask 077; sed "s/^PASSWORD=.*/PASSWORD=\"$pw\"/" settings.example > "$CONF_DIR/settings")
  echo "Created $CONF_DIR/settings with a random hotspot password: $pw"
fi

echo
wifi-hotspot check || true
echo
echo "Next steps:"
echo "  - Hotspot name and password: wifi-hotspot config (or the gear icon in the Wi-Fi Hotspot app)"
echo "  - Turn it on: wifi-hotspot start, the Wi-Fi Hotspot app, or the Hotspot toggle in the GNOME system menu"
