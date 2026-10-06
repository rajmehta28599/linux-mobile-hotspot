// wifi-hotspot Quick Settings toggle for GNOME Shell 45+.
//
// Start / stop runs the wifi-hotspot CLI with SUDO_ASKPASS pointing at wifi-hotspot-gui, so the
// sudo password is asked in a dialog. Whether the hotspot is up is polled cheaply from
// /sys/class/net/<AP_IFACE>; details and connected stations come from `wifi-hotspot-gui --json`,
// which is only run while the hotspot is up.
// License: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const ICON = 'network-wireless-hotspot-symbolic';
const TITLE = 'Wi-Fi Hotspot';
const DESKTOP_ID = 'wifi-hotspot-gui.desktop';
const DEFAULT_PASSWORD = 'change-me-please';
const POLL_SECONDS = 3;
const DETAILS_EVERY_N_POLLS = 3; // while the menu is closed: refresh the device count every ~9 s
const CONF_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'wifi-hotspot']);
const SETTINGS_FILE = GLib.build_filenamev([CONF_DIR, 'settings']);
const STATE_FILE = GLib.build_filenamev([CONF_DIR, 'run', 'state']);
const BUSY_LABELS = {start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…'};
const PLACEHOLDERS = {
    off: 'Turn on the hotspot to share this computer\'s Wi-Fi connection.',
    interrupted: 'The Wi-Fi connection moved to another channel. Click Hotspot to restart it.',
    on: 'No devices connected',
};

// ---------------------------------------------------------------- helpers

/** KEY=value assignments of a settings / state file. The last one wins, as with `source`. */
function readShellVars(path) {
    const vars = {};
    let text;
    try {
        text = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return vars;
    }
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m)
            vars[m[1]] = unquote(m[2].trim());
    }
    return vars;
}

function unquote(value) {
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        const end = value.indexOf(quote, 1);
        return value.slice(1, end < 0 ? undefined : end);
    }
    // unquoted word, possibly with backslash escapes (printf %q)
    return value.match(/^(?:\\.|[^\s\\])*/)[0].replace(/\\(.)/g, '$1');
}

function findProgram(name) {
    const path = GLib.find_program_in_path(name);
    if (path)
        return path;
    const fallback = `/usr/local/bin/${name}`;
    return GLib.file_test(fallback, GLib.FileTest.IS_EXECUTABLE) ? fallback : null;
}

function apInterface() {
    const iface = readShellVars(STATE_FILE).AP_IFACE || readShellVars(SETTINGS_FILE).AP_IFACE || 'ap0';
    return /^[\w.-]+$/.test(iface) ? iface : 'ap0';
}

function usesDefaultPassword() {
    const settings = readShellVars(SETTINGS_FILE);
    return settings.SECURITY !== 'open' && (settings.PASSWORD ?? DEFAULT_PASSWORD) === DEFAULT_PASSWORD;
}

/**
 * Run argv and collect stdout. stdin is an empty pipe, so the CLI has no TTY and uses `sudo -A`.
 *
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function run(argv, {env = {}, flags = Gio.SubprocessFlags.NONE, cancellable = null} = {}) {
    return new Promise((resolve, reject) => {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | flags,
        });
        for (const [key, value] of Object.entries(env))
            launcher.setenv(key, value, true);
        try {
            launcher.spawnv(argv).communicate_utf8_async(null, cancellable, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    resolve({ok: proc.get_successful(), output: stdout ?? ''});
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function lastLines(text, n = 6) {
    return text.trim().split('\n').slice(-n).join('\n') || 'No output';
}

function signalIcon(dbm) {
    if (typeof dbm !== 'number')
        return 'network-wireless-signal-none-symbolic';
    if (dbm >= -55)
        return 'network-wireless-signal-excellent-symbolic';
    if (dbm >= -67)
        return 'network-wireless-signal-good-symbolic';
    if (dbm >= -75)
        return 'network-wireless-signal-ok-symbolic';
    return 'network-wireless-signal-weak-symbolic';
}

function closeQuickSettings() {
    if (Main.panel.closeQuickSettings)
        Main.panel.closeQuickSettings();
    else
        Main.panel.statusArea.quickSettings?.menu.close();
}

function openApp() {
    Main.overview.hide();
    closeQuickSettings();
    const app = Shell.AppSystem.get_default().lookup_app(DESKTOP_ID);
    if (app) {
        app.activate();
        return;
    }
    const gui = findProgram('wifi-hotspot-gui');
    if (gui)
        Gio.Subprocess.new([gui], Gio.SubprocessFlags.NONE);
    else
        Main.notifyError(TITLE, 'wifi-hotspot-gui is not installed. Run: ./install.sh --gui');
}

// ---------------------------------------------------------------- UI

const DeviceItem = GObject.registerClass(
class DeviceItem extends PopupMenu.PopupBaseMenuItem {
    constructor() {
        super({style_class: 'wifi-hotspot-device'});

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this.add_child(this._icon);

        this._name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._name);

        this._address = new St.Label({style_class: 'device-subtitle', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._address);

        this.connect('activate', () => this._copyAddress());
    }

    update(dev) {
        this._ip = dev.ip;
        this._icon.icon_name = signalIcon(dev.signal);
        this._name.text = dev.hostname || 'Unknown device';
        this._address.text = dev.ip || dev.mac;
        this.accessible_name = dev.ip ? `Copy IP address of ${this._name.text}` : this._name.text;
    }

    _copyAddress() {
        if (!this._ip)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._ip);
        Main.notify(TITLE, `Copied ${this._ip} (${this._name.text}) to the clipboard`);
    }
});

const HotspotToggle = GObject.registerClass(
class HotspotToggle extends QuickMenuToggle {
    constructor() {
        super({title: 'Hotspot', iconName: ICON});
        if ('menuButtonAccessibleName' in this)
            this.menuButtonAccessibleName = 'Open hotspot menu';

        this._state = 'off';
        this._up = false;
        this._info = null;
        this._busy = null;
        this._fetching = false;
        this._polls = 0;
        this._items = new Map();
        this._cancellable = new Gio.Cancellable();

        this.menu.setHeader(ICON, TITLE);
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this._placeholder = new PopupMenu.PopupMenuItem('', {
            style_class: 'wifi-hotspot-placeholder',
            reactive: false,
            can_focus: false,
        });
        this._placeholder.label.clutter_text.set({ellipsize: Pango.EllipsizeMode.NONE, line_wrap: true});
        this.menu.addMenuItem(this._placeholder);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Hotspot Settings', () => openApp());

        this.connect('clicked', () => this._onClicked().catch(e => logError(e, 'wifi-hotspot')));
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._poll(true);
        });
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._poll(false);
            return GLib.SOURCE_CONTINUE;
        });
        this.connect('destroy', () => {
            GLib.source_remove(this._pollId);
            this._cancellable.cancel();
            this.menu.destroy();
        });

        this._poll(true);
    }

    async _onClicked() {
        if (this._busy)
            return;
        const action = {on: 'stop', interrupted: 'restart'}[this._state] ?? 'start';

        if (action !== 'stop' && usesDefaultPassword()) {
            Main.notify(TITLE, 'Set a hotspot password first: in Hotspot Settings, click the gear icon.');
            openApp();
            return;
        }
        const cli = findProgram('wifi-hotspot');
        if (!cli) {
            Main.notifyError(TITLE, 'wifi-hotspot is not installed. Run: ./install.sh');
            return;
        }
        const env = {NO_COLOR: '1'};
        const askpass = findProgram('wifi-hotspot-gui');
        if (askpass)
            env.SUDO_ASKPASS = askpass;

        // The password dialog must not open underneath the Quick Settings grab.
        closeQuickSettings();
        this._busy = action;
        this._sync();

        let result;
        try {
            result = await run([cli, action],
                {env, flags: Gio.SubprocessFlags.STDERR_MERGE, cancellable: this._cancellable});
        } catch (e) {
            if (isCancelled(e))
                return; // toggle destroyed (extension disabled, screen locked)
            result = {ok: false, output: e.message};
        }
        this._busy = null;

        if (/authentication failed/.test(result.output))
            Main.notify(TITLE, 'Authentication was cancelled or failed; nothing was changed.');
        else if (!result.ok)
            Main.notifyError(`Could not ${action} the hotspot`, lastLines(result.output));
        this._poll(true);
    }

    _poll(forceDetails) {
        this._up = GLib.file_test(`/sys/class/net/${apInterface()}`, GLib.FileTest.EXISTS);
        if (!this._up) {
            this._info = null;
            this._polls = 0;
        } else if (forceDetails || this.menu.isOpen || this._polls++ % DETAILS_EVERY_N_POLLS === 0) {
            this._fetchDetails().catch(e => logError(e, 'wifi-hotspot'));
        }
        this._sync();
    }

    async _fetchDetails() {
        const gui = findProgram('wifi-hotspot-gui');
        if (!gui || this._fetching)
            return;
        this._fetching = true;
        try {
            const {output} = await run([gui, '--json'],
                {flags: Gio.SubprocessFlags.STDERR_SILENCE, cancellable: this._cancellable});
            this._info = JSON.parse(output);
        } catch (e) {
            if (isCancelled(e))
                return;
            this._info = null;
        } finally {
            this._fetching = false;
        }
        this._sync();
    }

    _sync() {
        const info = this._up ? this._info : null;
        if (!this._up || (info && !info.running && !info.interrupted))
            this._state = 'off';
        else
            this._state = info?.interrupted ? 'interrupted' : 'on';
        const on = this._state === 'on';
        const devices = on ? info?.devices ?? [] : [];

        this.checked = this._state !== 'off';
        if (this._busy)
            this.subtitle = BUSY_LABELS[this._busy];
        else if (this._state === 'interrupted')
            this.subtitle = 'Interrupted';
        else if (on && devices.length > 1)
            this.subtitle = `${devices.length} devices`;
        else if (on && devices.length === 1)
            this.subtitle = devices[0].hostname || devices[0].ip || '1 device';
        else
            this.subtitle = on && info?.ssid ? info.ssid : null;

        let header = 'Off';
        if (this._state === 'interrupted')
            header = 'Interrupted';
        else if (on)
            header = info?.ssid ? `${info.ssid} · ${info.band}, channel ${info.channel}` : 'On';
        this.menu.setHeader(ICON, TITLE, header);

        this._syncDevices(devices);
        this._placeholder.label.text = PLACEHOLDERS[this._state];
        this._placeholder.visible = devices.length === 0;
    }

    _syncDevices(devices) {
        const seen = new Set();
        for (const dev of devices) {
            seen.add(dev.mac);
            let item = this._items.get(dev.mac);
            if (!item) {
                item = new DeviceItem();
                this._items.set(dev.mac, item);
                this._deviceSection.addMenuItem(item);
            }
            item.update(dev);
        }
        for (const [mac, item] of this._items) {
            if (!seen.has(mac)) {
                item.destroy();
                this._items.delete(mac);
            }
        }
    }
});

const HotspotIndicator = GObject.registerClass(
class HotspotIndicator extends SystemIndicator {
    constructor() {
        super();
        const icon = this._addIndicator();
        icon.icon_name = ICON;

        const toggle = new HotspotToggle();
        toggle.bind_property('checked', icon, 'visible', GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(toggle);
    }
});

/**
 * Move the toggle right after the network (Wi-Fi) toggles. This uses a private field of the
 * Quick Settings panel, so on any failure the toggle simply stays at its default position.
 */
function placeAfterNetworkToggles(quickSettings, toggle) {
    try {
        const grid = toggle.get_parent();
        const anchor = (quickSettings._network?.quickSettingsItems ?? [])
            .filter(item => item.get_parent() === grid).at(-1);
        if (anchor)
            grid.set_child_above_sibling(toggle, anchor);
    } catch (e) {
        console.warn(`wifi-hotspot: keeping the default toggle position: ${e.message}`);
    }
}

export default class WifiHotspotExtension extends Extension {
    enable() {
        this._indicator = new HotspotIndicator();
        this._attempts = 0;
        this._addToPanel();
    }

    disable() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }

    _addToPanel() {
        const quickSettings = Main.panel.statusArea.quickSettings;
        // The built-in indicators are created asynchronously at login. Wait for them (up to 5 s) so
        // the toggle can be placed next to the Wi-Fi toggle.
        if (quickSettings._backgroundApps === undefined && this._attempts++ < 50) {
            this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._retryId = 0;
                this._addToPanel();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        quickSettings.addExternalIndicator(this._indicator);
        placeAfterNetworkToggles(quickSettings, this._indicator.quickSettingsItems[0]);
    }
}
