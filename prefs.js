// Bubbles Screensaver — Author: Nicolas-Gth
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const STYLE_KEYS = ['iridescent', 'multicolor', 'transparent', 'custom'];
const spinRows = [];

function addSpin(group, settings, key, title, subtitle, lower, upper, step, digits,
    factor = 1, type = 'int') {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 10,
    });
    const row = new Adw.SpinRow({title, subtitle, digits, adjustment});

    const read = () => type === 'int' ? settings.get_int(key) : settings.get_double(key);
    const write = value => {
        const stored = value / factor;
        if (type === 'int')
            settings.set_int(key, Math.round(stored));
        else
            settings.set_double(key, stored);
    };
    const refresh = () => {
        const value = read() * factor;
        row.value = type === 'int' ? Math.round(value) : value;
    };

    refresh();
    row.connect('notify::value', () => write(row.value));
    row._refresh = refresh;
    spinRows.push(row);
    group.add(row);
    return row;
}

export default class BubblesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        spinRows.length = 0;

        const settings = this.getSettings();
        window.set_default_size(640, 900);

        const page = new Adw.PreferencesPage({
            title: _('Bubbles'),
            icon_name: 'preferences-desktop-screensaver-symbolic',
        });
        window.add(page);

        const bubbles = new Adw.PreferencesGroup({
            title: _('Bubbles'),
        });
        page.add(bubbles);

        const styleRow = new Adw.ComboRow({
            title: _('Style'),
            model: Gtk.StringList.new([
                _('Iridescent'),
                _('Multicolor'),
                _('Transparent'),
                _('Custom color'),
            ]),
        });
        bubbles.add(styleRow);

        const customRow = new Adw.ActionRow({
            title: _('Custom color'),
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        customRow.add_suffix(colorButton);
        bubbles.add(customRow);

        const colorToHex = rgba => '#' + [rgba.red, rgba.green, rgba.blue]
            .map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)
                .toString(16).padStart(2, '0')).join('');

        const hexToColor = value => {
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(value ?? ''))
                rgba.parse('#7fb8e6');
            return rgba;
        };

        let updatingStyle = false;
        let updatingColor = false;

        const refreshStyle = () => {
            const style = settings.get_string('style');
            let index = STYLE_KEYS.indexOf(style);
            if (index < 0)
                index = 0;

            updatingStyle = true;
            styleRow.selected = index;
            updatingStyle = false;
            customRow.visible = style === 'custom';
        };

        const refreshColor = () => {
            updatingColor = true;
            colorButton.rgba = hexToColor(settings.get_string('custom-color'));
            updatingColor = false;
        };

        styleRow.connect('notify::selected', () => {
            if (updatingStyle)
                return;
            const style = STYLE_KEYS[styleRow.selected];
            if (style && settings.get_string('style') !== style)
                settings.set_string('style', style);
        });

        colorButton.connect('notify::rgba', () => {
            if (updatingColor)
                return;
            const rgba = colorButton.rgba;
            if (!rgba)
                return;
            const color = colorToHex(rgba);
            if (settings.get_string('custom-color') !== color)
                settings.set_string('custom-color', color);
        });

        settings.connect('changed::style', refreshStyle);
        settings.connect('changed::custom-color', refreshColor);
        refreshStyle();
        refreshColor();

        const explodeSwitch = new Adw.SwitchRow({
            title: _('Explode on exit'),
            subtitle: _('Burst bubbles into a droplet cloud when exiting the screensaver'),
        });
        settings.bind('explode-on-exit', explodeSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        bubbles.add(explodeSwitch);

        addSpin(bubbles, settings, 'bubble-count', _('Number of bubbles'),
            _('Target number of bubbles on screen'), 1, 200, 1, 0);

        addSpin(bubbles, settings, 'bubble-layers', _('Bubble layers'),
            _('Number of depth layers (the bubble count is divided between them)'),
            1, 5, 1, 0);

        addSpin(bubbles, settings, 'bubble-size', _('Average size'),
            _('Average radius, as % of the smallest screen side'),
            1, 30, 0.5, 1, 1, 'double');

        addSpin(bubbles, settings, 'bubble-size-variation', _('Size variation'),
            _('Random variation around the average size, in %'),
            0, 100, 1, 0, 1, 'double');

        addSpin(bubbles, settings, 'bubble-speed', _('Speed'),
            _('Cruising speed, as % of the smallest side per second'),
            0.2, 20, 0.1, 1, 1, 'double');

        addSpin(bubbles, settings, 'spawn-interval', _('Spawn interval'),
            _('Average delay between two bubbles (smaller = more bubbles arriving)'),
            0.05, 5, 0.05, 2, 1, 'double');

        const timing = new Adw.PreferencesGroup({
            title: _('Timing'),
        });
        page.add(timing);

        addSpin(timing, settings, 'activation-delay', _('Activate after idle'),
            _('Delay before the screensaver starts, in minutes'),
            1, 1440, 1, 0, 1 / 60, 'int');

        addSpin(timing, settings, 'fade-delay', _('Fade to black after'),
            _('Length of the transparent phase before the fade, in seconds'),
            0, 3600, 5, 0, 1, 'int');

        const misc = new Adw.PreferencesGroup({
            title: _('Miscellaneous'),
        });
        page.add(misc);

        const testRow = new Adw.ButtonRow({
            title: _('Launch the screensaver now'),
        });
        testRow.connect('activated', () => settings.set_boolean('test-now', true));
        misc.add(testRow);

        const resetSettings = () => {
            for (const key of settings.list_keys())
                settings.reset(key);
            for (const row of spinRows)
                row._refresh();
            refreshStyle();
            refreshColor();
        };

        const resetRow = new Adw.ActionRow({
            title: _('Reset to defaults'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset settings?'),
                body: _('All settings will be restored to their default values.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (d, response) => {
                if (response === 'reset')
                    resetSettings();
            });
            dialog.present(window);
        });
        resetRow.add_suffix(resetButton);
        misc.add(resetRow);

        const about = new Adw.PreferencesGroup({
            title: _('About'),
        });
        page.add(about);

        const iconFile = this.dir.get_child('icon.png');
        if (iconFile.query_exists(null)) {
            const icon = new Gtk.Image({
                file: iconFile.get_path(),
                pixel_size: 96,
                margin_top: 12,
                margin_bottom: 6,
            });
            about.add(icon);
        }

        const description = new Gtk.Label({
            label: _('A GNOME screensaver that draws bubbles in the shell after idle.'),
            wrap: true,
            xalign: 0,
            margin_bottom: 6,
        });
        description.add_css_class('dim-label');
        about.add(description);

        const author = new Gtk.Label({
            label: _('Author: Nicolas-Gth'),
            xalign: 0,
            margin_bottom: 6,
        });
        author.add_css_class('dim-label');
        about.add(author);
    }
}
