// Bubbles Screensaver — Author: Nicolas-Gth
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LOOK} from './look.js';
import {BubblesOverlay} from './overlay.js';

const LOGIN_SERVICE = 'org.freedesktop.login1';
const LOGIN_PATH = '/org/freedesktop/login1';
const LOGIN_IFACE = 'org.freedesktop.login1.Manager';

export default class BubblesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = null;
        this._active = false;
        this._dismissing = false;
        this._pollId = 0;
        this._settingsSignal = 0;
        this._monitorsSignal = 0;
        this._destroyed = false;

        // Wait for one real user action after enabling before the screensaver
        // is allowed to start on its own.
        this._armed = false;
        this._graceUntil = 0;

        this._loginProxy = null;
        this._loginSignalId = 0;
        this._loginLoading = false;
        this._suspendRequested = false;
        this._suspendCooldownUntil = 0;

        this._settingsSignal = this._settings.connect('changed',
            () => this._onSettingsChanged());

        this._monitorsSignal = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());

        // One lightweight, in-process read every second. No D-Bus, no blocking.
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1,
            () => this._tick());

        this._ensureLoginProxy();
    }

    disable() {
        this._destroyed = true;

        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._settingsSignal) {
            this._settings.disconnect(this._settingsSignal);
            this._settingsSignal = 0;
        }
        if (this._monitorsSignal) {
            Main.layoutManager.disconnect(this._monitorsSignal);
            this._monitorsSignal = 0;
        }

        this._deactivate(false);

        if (this._loginProxy && this._loginSignalId) {
            this._loginProxy.disconnect(this._loginSignalId);
            this._loginSignalId = 0;
        }

        this._loginProxy = null;
        this._settings = null;
    }

    // ---------------------------------------------------------------- helpers

    _onSettingsChanged() {
        if (!this._settings)
            return;

        this._suspendRequested = false;

        // "Launch the screensaver now" button in the preferences.
        if (this._settings.get_boolean('test-now')) {
            this._settings.set_boolean('test-now', false);
            this._activate();
        }

        if (this._active && this._overlay) {
            this._overlay.setStyle(
                this._settings.get_string('style'),
                this._settings.get_string('custom-color'));
        }
    }

    _onMonitorsChanged() {
        if (this._active)
            this._deactivate(false);
    }

    _isLocked() {
        try {
            return Main.sessionMode.isLocked === true;
        } catch (e) {
            return false;
        }
    }

    _idleMs() {
        try {
            return global.backend.get_core_idle_monitor().get_idletime();
        } catch (e) {
            return 0;
        }
    }

    _tick() {
        if (this._destroyed || !this._settings)
            return GLib.SOURCE_REMOVE;

        try {
            this._update();
        } catch (e) {
            logError(e, '[Bubbles] update failed');
        }

        return GLib.SOURCE_CONTINUE;
    }

    _update() {
        // A click on "Launch now" may have happened while the extension was
        // disabled, leaving the flag set. Clear it; the user can press the
        // button again once the extension is running.
        if (this._settings.get_boolean('test-now')) {
            this._settings.set_boolean('test-now', false);
            return;
        }

        const idle = this._idleMs();

        if (idle < 1000) {
            this._armed = true;
            this._suspendRequested = false;
        }

        if (this._isLocked()) {
            if (this._active)
                this._deactivate(false);
        } else if (this._active) {
            // Any input dismisses the screensaver. The overlay does not grab
            // input, so the compositor still resets the idle time.
            if (!this._dismissing && idle < 1000 &&
                GLib.get_monotonic_time() >= this._graceUntil) {
                this._deactivate(true);
            }
        } else if (this._armed) {
            const activation = this._settings.get_int('activation-delay');
            if (idle >= activation * 1000)
                this._activate();
        }

        this._maybeSuspend(idle);
    }

    _activate() {
        if (this._destroyed || this._active || this._isLocked())
            return;

        const look = {
            ...LOOK,
            style: this._settings.get_string('style'),
            customColor: this._settings.get_string('custom-color'),
        };

        try {
            this._overlay = new BubblesOverlay({
                settings: this._settings,
                look,
                burst: this._readBurstConfig(),
                onDismiss: () => this._deactivate(true),
                onError: e => this._onOverlayError(e),
            });
            this._overlay.show();
            this._active = true;
            // Ignore the activity that triggered a manual test for a moment.
            this._graceUntil = GLib.get_monotonic_time() + 3 * 1000 * 1000;
        } catch (e) {
            logError(e, '[Bubbles] cannot start the screensaver');
            this._deactivate(false);
        }
    }

    _readBurstConfig() {
        try {
            const path = this.dir.get_child('burst.json').get_path();
            const [, bytes] = GLib.file_get_contents(path);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            logError(e, '[Bubbles] cannot read burst.json');
            return {};
        }
    }

    _deactivate(animate = true) {
        this._graceUntil = 0;

        if (!this._overlay) {
            this._active = false;
            this._dismissing = false;
            return;
        }

        if (!animate) {
            this._overlay.destroy();
            this._overlay = null;
            this._active = false;
            this._dismissing = false;
            return;
        }

        if (this._dismissing)
            return;

        if (!this._settings.get_boolean('explode-on-exit')) {
            this._deactivate(false);
            return;
        }

        this._dismissing = true;
        const overlay = this._overlay;
        overlay.dismiss(() => {
            if (this._overlay === overlay)
                this._overlay = null;
            overlay.destroy();
            this._dismissing = false;
            this._active = false;
        });
    }

    _onOverlayError(e) {
        logError(e, '[Bubbles] rendering failed');
        this._deactivate(false);
    }

    // ------------------------------------------------------------- suspend

    _maybeSuspend(idle) {
        const minutes = this._settings.get_int('suspend-delay');
        if (minutes <= 0 || idle < minutes * 60000 || this._suspendRequested)
            return;

        if (GLib.get_monotonic_time() < this._suspendCooldownUntil)
            return;

        if (!this._loginProxy) {
            this._ensureLoginProxy();
            return;
        }

        this._suspendRequested = true;
        this._suspend();
    }

    _ensureLoginProxy() {
        if (this._loginProxy || this._loginLoading || this._destroyed)
            return;

        this._loginLoading = true;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            LOGIN_SERVICE, LOGIN_PATH, LOGIN_IFACE, null,
            (source, res) => {
                this._loginLoading = false;
                if (this._destroyed)
                    return;

                try {
                    this._loginProxy = Gio.DBusProxy.new_for_bus_finish(res);
                    this._loginSignalId = this._loginProxy.connect('g-signal',
                        (proxy, sender, signal, params) => {
                            if (signal !== 'PrepareForSleep')
                                return;
                            const [sleeping] = params.deep_unpack();
                            if (sleeping)
                                this._deactivate(false);
                        });
                } catch (e) {
                    logError(e, '[Bubbles] logind unavailable');
                    this._loginProxy = null;
                }
            });
    }

    _suspend() {
        this._loginProxy.call(
            'Suspend', new GLib.Variant('(b)', [false]),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    logError(e, '[Bubbles] suspend failed');
                    if (!this._destroyed) {
                        this._suspendRequested = false;
                        this._suspendCooldownUntil =
                            GLib.get_monotonic_time() + 60 * 1000 * 1000;
                    }
                }
            });
    }
}
