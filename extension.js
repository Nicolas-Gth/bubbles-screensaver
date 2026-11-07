// Bubbles Screensaver — Author: Nicolas-Gth
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BURST} from './burst.js';
import {LOOK} from './look.js';
import {BubblesOverlay} from './overlay.js';

const SESSION_SERVICE = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';
const SESSION_IFACE = 'org.gnome.SessionManager';

// org.gnome.SessionManager inhibitor flag asking to keep the session idle.
const INHIBIT_IDLE = 8;
const INHIBIT_REFRESH_US = 5 * 1000 * 1000;

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
        this._manual = false;

        // Idle inhibitors are reported by the session manager; refresh the cached state regularly
        // so the screensaver never covers inhibited activity.
        this._sessionProxy = null;
        this._sessionLoading = false;
        this._inhibited = false;
        this._inhibitedLoading = false;
        this._inhibitedCheckedAt = 0;

        this._settingsSignal = this._settings.connect('changed',
            () => this._onSettingsChanged());

        this._monitorsSignal = Main.layoutManager.connect('monitors-changed',
            () => this._onMonitorsChanged());

        // One lightweight, in-process read every second. The inhibitor state is
        // refreshed asynchronously at most every INHIBIT_REFRESH_US.
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1,
            () => this._tick());

        this._ensureSessionProxy();
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

        this._sessionProxy = null;
        this._inhibited = false;
        this._settings = null;
    }

    // ---------------------------------------------------------------- helpers

    _onSettingsChanged() {
        if (!this._settings)
            return;

        // "Launch the screensaver now" button in the preferences.
        if (this._settings.get_boolean('test-now')) {
            this._settings.set_boolean('test-now', false);
            // An explicit request may run even while something inhibits idle
            // (the user asked for it); it is dismissed by the next input.
            this._activate(true);
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

        this._refreshInhibited();

        const idle = this._idleMs();

        if (idle < 1000)
            this._armed = true;

        if (this._isLocked()) {
            if (this._active)
                this._deactivate(false);
            return;
        }

        // An application is asking the session to stay idle (video playback,
        // screen sharing, a game, ...). Never draw over it, and hide the
        // screensaver if it is already visible. Wait for real user activity
        // before allowing it to start again.
        if (this._inhibited) {
            if (this._active && !this._manual) {
                this._armed = false;
                this._deactivate(false);
            }
            return;
        }

        if (this._active) {
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
    }

    _activate(manual = false) {
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
                burst: BURST,
                onDismiss: () => this._deactivate(true),
                onError: e => this._onOverlayError(e),
            });
            this._overlay.show();
            this._active = true;
            this._manual = manual;
            // Ignore the activity that triggered a manual test for a moment.
            this._graceUntil = GLib.get_monotonic_time() + 3 * 1000 * 1000;
        } catch (e) {
            logError(e, '[Bubbles] cannot start the screensaver');
            this._deactivate(false);
        }
    }

    _deactivate(animate = true) {
        this._graceUntil = 0;
        this._manual = false;

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

    // ------------------------------------------------------- idle inhibitors

    _ensureSessionProxy() {
        if (this._sessionProxy || this._sessionLoading || this._destroyed)
            return;

        this._sessionLoading = true;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            SESSION_SERVICE, SESSION_PATH, SESSION_IFACE, null,
            (source, res) => {
                this._sessionLoading = false;
                if (this._destroyed)
                    return;

                try {
                    this._sessionProxy = Gio.DBusProxy.new_for_bus_finish(res);
                    // Check right away instead of waiting for the next period.
                    this._inhibitedCheckedAt = 0;
                } catch (e) {
                    logError(e, '[Bubbles] session manager unavailable');
                    this._sessionProxy = null;
                }
            });
    }

    _refreshInhibited() {
        if (this._destroyed || this._inhibitedLoading)
            return;

        const now = GLib.get_monotonic_time();
        if (now - this._inhibitedCheckedAt < INHIBIT_REFRESH_US)
            return;
        this._inhibitedCheckedAt = now;

        if (!this._sessionProxy) {
            this._ensureSessionProxy();
            return;
        }

        this._inhibitedLoading = true;
        this._sessionProxy.call(
            'IsInhibited', new GLib.Variant('(u)', [INHIBIT_IDLE]),
            Gio.DBusCallFlags.NONE, -1, null,
            (proxy, res) => {
                this._inhibitedLoading = false;
                if (this._destroyed)
                    return;

                try {
                    const [inhibited] = proxy.call_finish(res).deep_unpack();
                    this._inhibited = inhibited === true;
                } catch (e) {
                    logError(e, '[Bubbles] cannot check idle inhibitors');
                }
            });
    }
}
