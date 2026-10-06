# Technical details

This document describes how Linux Mobile Hotspot works and how to configure it in detail. For installation
and everyday use, see the [README](../README.md).

## Architecture

The tool runs a Wi-Fi access point (AP) and a Wi-Fi client connection concurrently on one wireless NIC and
shares the client uplink with AP clients via NAT.

```
upstream AP  <-- wlo1 (managed) --[ phy0 ]-- ap0 (AP) -->  clients
                        same channel, single radio
            ap0: 192.168.50.1/24, DHCP .10-.100, NAT -> wlo1
```

The NetworkManager hotspot used by GNOME and KDE (`802-11-wireless.mode ap`) reuses the client interface and
therefore drops the upstream connection. This tool instead adds a virtual `__ap` interface on the same `phy`,
drives it with `hostapd`, serves DHCP with `dnsmasq`, and masquerades through the client interface. The Mobile
hotspot feature of Windows uses the same concept: a virtual AP adapter on the same radio.

| Component | Description |
|---|---|
| `wifi-hotspot` | CLI (bash): `check`, `start`, `stop`, `restart`, `status`, `config` |
| `wifi-hotspot-gui` | Desktop app (Python, GTK 4, libadwaita) |
| `gnome-extension/` | GNOME Shell extension `wifi-hotspot@linux-mobile-hotspot` (Quick Settings toggle) |
| `install.sh` | Dependency installation, installation to `/usr/local`, uninstallation |
| `settings.example` | Settings template |

The desktop app and the toggle run the CLI for every privileged step.

## Hardware requirements

Whether a card supports concurrent client and AP operation depends on its driver. `wifi-hotspot check`
evaluates the following without root:

| Requirement | Manual verification |
|---|---|
| AP mode supported | `iw phy <phy> info`: *Supported interface modes* contains `AP` |
| Concurrent managed + AP | *valid interface combinations* has an entry containing both `managed` and `AP` |
| Channel count | `#channels <= 1` means the AP must share the client's channel (typical; the tool always does this) |
| AP permitted on the current channel | The channel is not flagged `no IR`, `radar detection` or `disabled` in `iw phy <phy> info` |

| Driver | Typical result |
|---|---|
| `iwlwifi` (Intel AX200/201/210/211, BE200, 700-series CNVi) | managed + AP, single channel; 5 GHz AP limited to channels without `no IR` (LAR) |
| `ath9k`, `ath10k` | Generally supported |
| `mt76` (MT7921/7922) | Generally supported |
| `brcmfmac` (Raspberry Pi 3/4/5 onboard) | Generally managed + AP, single channel |
| `rtw88`, `rtw89`, `rtl8xxxu` | Varies by chip and firmware |
| `wl` (Broadcom proprietary) | No AP mode |

## Settings

`~/.config/wifi-hotspot/settings` is a shell file that the CLI sources. Quote values that contain shell
metacharacters with single quotes. Apply changes with `wifi-hotspot restart`; the desktop app does this
automatically when you save while the hotspot is running.

| Key | Default | Values |
|---|---|---|
| `SSID` | `LinuxHotspot` | 1 to 32 bytes |
| `PASSWORD` | random (set by `install.sh`) | 8 to 63 characters (WPA passphrase / SAE password) |
| `BAND` | `auto` | `auto`, `2.4`, `5` |
| `SECURITY` | `wpa2` | `wpa2`, `wpa3`, `wpa2-wpa3`, `open` |
| `WIFI_IFACE` | auto | Upstream interface; default is the first `managed` interface listed by `iw dev` |
| `AP_IFACE` | `ap0` | Name of the virtual AP interface |
| `SUBNET` | `192.168.50` | /24 prefix of the hotspot network |
| `DNS` | `8.8.8.8,1.1.1.1` | DNS servers announced to clients (DHCP option 6) |

Credentials are stored in plain text in the settings file and in the generated
`~/.config/wifi-hotspot/run/hostapd.conf`, both with mode 600 inside a mode 700 directory. `.gitignore`
excludes both, so a settings file inside a clone is not committed by accident.

## Channel and band selection

With `#channels <= 1`, the AP must operate on the client's channel:

| Upstream state | AP channel |
|---|---|
| Associated, 2.4 GHz | Same channel (`hw_mode=g`, 802.11n) |
| Associated, 5 GHz, channel permits initiating radiation | Same channel (`hw_mode=a`, 802.11n/ac) |
| Associated, 5 GHz, `no IR` or DFS channel | Refuses to start; associate the client on 2.4 GHz |
| Not associated | `BAND=2.4` or `auto`: channel 6. `BAND=5`: first permitted of 149, 153, 157, 161, 36, 40, 44, 48 |

`BAND` is ignored while the client is associated; a warning is printed if it conflicts with the upstream band.

The set of channels that permit initiating radiation is not static. On `iwlwifi`, Location Aware Regulatory
(LAR) updates it at runtime, so a 5 GHz channel that allowed an AP earlier can later be flagged `no IR`. When
the client interface moves to another channel, the kernel stops the AP; `ap0` stays in AP mode without
beaconing, which the tools report as *interrupted*. Pinning the upstream connection to one band avoids this:

```sh
nmcli connection modify "<connection name>" 802-11-wireless.band bg   # bg = 2.4 GHz, a = 5 GHz
nmcli connection up "<connection name>"
```

## Security modes

| `SECURITY` | hostapd configuration |
|---|---|
| `wpa2` | `wpa=2`, `wpa_key_mgmt=WPA-PSK`, `rsn_pairwise=CCMP` |
| `wpa3` | `wpa=2`, `wpa_key_mgmt=SAE`, `rsn_pairwise=CCMP`, `ieee80211w=2`, `sae_pwe=2` |
| `wpa2-wpa3` | `wpa_key_mgmt=WPA-PSK SAE`, `ieee80211w=1`, `sae_pwe=2` (transition mode) |
| `open` | No RSN |

`wpa3` requires SAE support in hostapd (2.7 or later) and in every client. Use `wpa2-wpa3` for mixed sets of
clients.

## What `start` does

`wifi-hotspot start` performs the equivalent of:

```sh
# Keep NetworkManager away from ap0. Otherwise wpa_supplicant switches it to managed mode,
# which violates the "#{ managed } <= 1" interface combination and fails with EBUSY.
echo 'ACTION=="add", SUBSYSTEM=="net", KERNEL=="ap0", ENV{NM_UNMANAGED}="1"' \
  | sudo tee /etc/udev/rules.d/90-wifi-hotspot-unmanaged.rules
sudo udevadm control --reload

# Virtual AP interface. Its MAC address is the upstream MAC with the locally administered bit set.
sudo iw dev wlo1 interface add ap0 type __ap addr <laa-mac>

sudo ip addr add 192.168.50.1/24 dev ap0
sudo hostapd -B -P run/hostapd.pid run/hostapd.conf      # channel = upstream channel

sudo dnsmasq --conf-file=/dev/null --interface=ap0 --bind-interfaces --except-interface=lo \
  --listen-address=192.168.50.1 --dhcp-range=192.168.50.10,192.168.50.100,12h \
  --dhcp-option=6,8.8.8.8,1.1.1.1 --pid-file=run/dnsmasq.pid

sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -I POSTROUTING -s 192.168.50.0/24 -o wlo1 -j MASQUERADE
sudo iptables -I FORWARD -i ap0 -o wlo1 -j ACCEPT
sudo iptables -I FORWARD -i wlo1 -o ap0 -m state --state RELATED,ESTABLISHED -j ACCEPT
sudo iptables -I INPUT -i ap0 -j ACCEPT
```

Firewall rules are inserted idempotently (`-C` before `-I`) and removed again by `stop`. When firewalld is
active, `ap0` is added to the `trusted` zone and masquerading is enabled on the upstream interface's zone.
`net.ipv4.ip_forward` stays enabled after `stop`.

hostapd and dnsmasq are started from the user's session. They therefore normally end when the user logs
out; `ap0` remains, and the next `start` cleans it up.

## What `stop` does

`stop` signals hostapd and dnsmasq through their pid files and also matches the process name
(`pkill -F <pidfile> -x <name>`): dnsmasq drops its privileges to `nobody` and cannot delete its pid file from
the mode 700 run directory, so the recorded PID may meanwhile belong to an unrelated process. It then removes
the firewall rules, deletes `ap0` and removes the runtime state.

## Privileges and running without a terminal

The CLI runs as a regular user and uses `sudo` for each privileged step. When standard input is not a
terminal and `SUDO_ASKPASS` is set, it uses `sudo -A`. The desktop app and the toggle set `SUDO_ASKPASS` to
`wifi-hotspot-gui`, which then shows a password dialog (`wifi-hotspot-gui --askpass`). Both `start` and `stop`
authenticate once at the beginning, so cancelling the dialog does not trigger further prompts.

## Desktop app

The app polls the system every 2 seconds. Expanding a connected device shows:

| Field | Source |
|---|---|
| IP address, hostname, lease expiry | dnsmasq lease file |
| MAC address | `iw dev ap0 station dump` |
| Vendor | IEEE OUI registry (`ieee-data` / `hwdata`); locally administered MACs are shown as randomized |
| Signal (dBm, quality) | station dump `signal` |
| Link speed to / from the device | `tx bitrate` / `rx bitrate` |
| Downloaded / uploaded by the device | `tx bytes` / `rx bytes` (from the AP's perspective) |
| Packets, TX retries / failures | station dump counters |
| Connected for, last activity | `connected time`, `inactive time` |

The station list comes from the kernel, not from DHCP leases, so it only contains currently associated
devices. `wifi-hotspot-gui --json` prints the collected state and exits, which is useful for scripts and bug
reports.

## GNOME Quick Settings toggle

The extension adds a `QuickMenuToggle` through the public `addExternalIndicator()` API and then moves it
after the network toggles (this step uses a private field of the panel and falls back to the default
position if that fails).

- While the hotspot is off, it only checks for `/sys/class/net/<AP_IFACE>` every 3 seconds and starts no
  process. While it is on, it runs `wifi-hotspot-gui --json` every 9 seconds, or every 3 seconds while the menu
  is open.
- Start, stop and restart run the CLI with `SUDO_ASKPASS` set, after closing the Quick Settings menu so that
  the password dialog is not hidden behind it.
- It refuses to start while `PASSWORD` is still the `settings.example` placeholder and opens the desktop app
  instead.
- Extensions are disabled while the screen is locked and enabled again afterwards; the toggle is rebuilt each
  time.

## Files

| Path | Purpose |
|---|---|
| `/usr/local/bin/wifi-hotspot`, `/usr/local/bin/wifi-hotspot-gui` | Programs |
| `/usr/local/share/applications/wifi-hotspot-gui.desktop` | Application menu entry |
| `~/.local/share/gnome-shell/extensions/wifi-hotspot@linux-mobile-hotspot/` | Quick Settings toggle |
| `~/.config/wifi-hotspot/settings` | Settings |
| `~/.config/wifi-hotspot/run/` | Runtime files: `hostapd.conf`, pid files, DHCP leases, state |
| `/etc/udev/rules.d/90-wifi-hotspot-unmanaged.rules` | Keeps NetworkManager away from `ap0` |

## Tested configurations

| Distribution | Kernel | NIC / driver | Userspace |
|---|---|---|---|
| Ubuntu 26.04.1 LTS | 7.0.0-34 | Intel 700 Series CNVi / `iwlwifi` | hostapd 2.11, dnsmasq 2.92, iptables 1.8.11 (nf_tables), NetworkManager 1.54.3, ufw, sudo-rs 0.2.13, GNOME Shell 50.1 |

Verified on this configuration:

- An earlier version of the same procedure (identical hostapd, dnsmasq and iptables steps): hotspot with
  connected clients, 2.4 GHz, WPA2.
- This release: `./install.sh --gnome`; `wifi-hotspot start` without a terminal through the password dialog
  (5 GHz channel 157, WPA2), with hostapd, dnsmasq and NAT coming up while the laptop stayed online; `stop`
  from the toggle, which ended both processes and removed `ap0` and all firewall rules. No client device was
  connected during these runs.
- The toggle in the Ubuntu session of GNOME Shell 50.1: loading and placement after the Wi-Fi toggle. Its
  menu, password check, start / stop / restart, interrupted state and lock / unlock handling were also
  exercised against simulated hotspot state.

Not yet verified:

- Connected devices listed in the desktop app and the toggle with real clients (this release)
- `wpa3` and `wpa2-wpa3`, firewalld, SELinux, distributions other than Ubuntu, GNOME Shell 45 to 49
- Dependency installation through dnf, pacman and zypper
