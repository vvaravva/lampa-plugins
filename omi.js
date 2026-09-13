(function () {
    'use strict';

    // =====================================================================
    //  Online MediaInfo — extra tags on cards in the "Онлайн" section
    //
    //  Adds the tags the balancer's own info line does not carry:
    //  source type (BDRemux / WEB-DL / BDRip…), Dolby Vision, HDR10+,
    //  video codec (x265 / AV1), bit depth (10bit), audio (Atmos /
    //  DTS-HD MA), channels (7.1 / 5.1) and release marks (IMAX,
    //  Extended, Proper…).
    //
    //  HOW IT WORKS
    //  The Lampac online plugin builds each card through
    //      Lampa.Template.get('lampac_prestige_full', element)
    //  where element is the raw object returned by the balancer. This
    //  plugin wraps Template.get, so it receives both the finished card
    //  and every field of element. Lampac emits no events of its own,
    //  and a MutationObserver would break on any markup change — the
    //  Template.get hook only depends on the template name.
    //
    //  WHERE THE DATA COMES FROM
    //  The release name may live in different fields depending on the
    //  balancer (title, text, details, name…), so the plugin joins ALL
    //  string fields of element and matches tokens against that. False
    //  positives are very unlikely: only known technical markers match.
    //
    //  IF NO TAGS SHOW UP, turn on "Режим діагностики" in the settings:
    //  the card will then list the fields the balancer actually sent.
    // =====================================================================

    var ID  = 'omi';
    var VER = '1.0.0';
    var LOG = '[online-mediainfo]';

    if (window.plugin_omi_ready) return;
    window.plugin_omi_ready = true;

    // Which templates to decorate.
    //
    // A hardcoded list of names was the original approach, and it was a
    // mistake: there are many online plugins (online.js, online_mod.js,
    // prestige forks) and each names its template differently. So the
    // name is matched by pattern instead. This is a cheap string test
    // rather than a DOM lookup, so Template.get stays fast.
    var NAME_RE = /online|lampac|prestige/i;

    // Where to insert the tag row — the first container that is found.
    var CONTAINERS = [
        '.online-prestige__body',   // Lampac prestige
        '.online__body',            // old bundled online plugin
        '.online-prestige',
        '.online'
    ];

    // Templates actually intercepted — surfaced in the settings screen so
    // the name can be identified straight from the TV.
    var seen = {};

    // Fields never parsed: links, images, internals.
    var SKIP_KEYS = [
        'url', 'link', 'stream', 'file', 'href', 'img', 'image', 'poster',
        'poster_path', 'backdrop_path', 'profile_path', 'hash', 'method',
        'timeline', 'subtitles', 'id', 'iframe'
    ];

    var MAX_TEXT = 2000;


    // =====================================================================
    //  PARSING RULES
    //  [group, label, regex]
    //  Within one group the FIRST match wins, so longer / more specific
    //  patterns come first (HDR10+ before HDR10 before HDR, DTS-HD MA
    //  before DTS-HD before DTS, WEB-DLRip before WEB-DL).
    // =====================================================================
    var RULES = [
        // ── source / rip type ───────────────────────────────────────────
        ['rip', 'REMUX',      /\b(?:bd|uhd|hd)?[-\s]?remux\b/i],
        ['rip', 'WEB-DLRip',  /\bweb[-\s]?dl[-\s]?rip\b/i],
        ['rip', 'WEB-DL',     /\bweb[-\s]?dl\b/i],
        ['rip', 'WEBRip',     /\bweb[-\s]?rip\b/i],
        ['rip', 'Blu-ray',    /\b(?:blu[-\s]?ray|bdmv|bd50|bd25)\b/i],
        ['rip', 'BDRip',      /\bbd[-\s]?rip\b/i],
        ['rip', 'HDTVRip',    /\bhdtv[-\s]?rip\b/i],
        ['rip', 'HDTV',       /\bhdtv\b/i],
        ['rip', 'DVDRip',     /\bdvd[-\s]?rip\b/i],
        ['rip', 'SATRip',     /\bsat[-\s]?rip\b/i],
        ['rip', 'HDRip',      /\bhd[-\s]?rip\b/i],
        ['rip', 'DVD',        /\bdvd[59]?\b/i],
        ['rip', 'WEB',        /\bweb\b/i],
        ['rip', 'CAMRip',     /\bcam[-\s]?rip\b|\bcamrip\b/i],
        ['rip', 'TS',         /\btelesync\b/i],

        // ── Dolby Vision (own group — it ships alongside HDR10) ─────────
        // \bDV\b deliberately without the i flag: lowercase "dv" shows up
        // far too often inside release-group names.
        ['dv',  'Dolby Vision', /\b(?:dolby[-\s]?vision|dovi)\b/i],
        ['dv',  'Dolby Vision', /\bDV\b/],

        // ── HDR ─────────────────────────────────────────────────────────
        ['hdr', 'HDR10+',     /\bhdr[-\s]?10[-\s]?\+|\bhdr10plus\b/i],
        ['hdr', 'HDR10',      /\bhdr[-\s]?10\b/i],
        ['hdr', 'HLG',        /\bhlg\b/i],
        ['hdr', 'HDR',        /\bhdr\b/i],
        ['hdr', 'SDR',        /\bsdr\b/i],

        // ── video codec ─────────────────────────────────────────────────
        ['codec', 'AV1',      /\bav1\b/i],
        ['codec', 'x265',     /\b(?:x[-\s]?265|h\.?[-\s]?265|hevc)\b/i],
        ['codec', 'x264',     /\b(?:x[-\s]?264|h\.?[-\s]?264|avc)\b/i],
        ['codec', 'XviD',     /\b(?:xvid|divx)\b/i],

        // ── colour depth ────────────────────────────────────────────────
        ['depth', '12bit',    /\b12[-\s]?bits?\b/i],
        ['depth', '10bit',    /\b10[-\s]?bits?\b/i],

        // ── Atmos on its own: it sits on top of TrueHD / DD+ ────────────
        ['atmos', 'Atmos',    /\batmos\b/i],

        // ── audio codec ─────────────────────────────────────────────────
        ['audio', 'DTS-X',    /\bdts[-\s]?x\b/i],
        ['audio', 'DTS-HD MA', /\bdts[-\s]?hd[-\s]?ma\b/i],
        ['audio', 'DTS-HD',   /\bdts[-\s]?hd\b/i],
        ['audio', 'TrueHD',   /\btrue[-\s]?hd\b/i],
        ['audio', 'DTS',      /\bdts\b/i],
        ['audio', 'DD+',      /\b(?:e[-\s]?ac[-\s]?3|dd\+|ddp|eac3)\b/i],
        ['audio', 'AC3',      /\b(?:ac[-\s]?3|dolby[-\s]?digital)\b/i],
        ['audio', 'FLAC',     /\bflac\b/i],
        ['audio', 'AAC',      /\baac\b/i],
        ['audio', 'Opus',     /\bopus\b/i],

        // ── channels ────────────────────────────────────────────────────
        ['ch', '7.1',         /\b7\.1\b/],
        ['ch', '5.1',         /\b5\.1\b/],
        ['ch', '2.0',         /\b2\.0\b/],

        // ── release marks (each in its own group, so all are shown) ─────
        ['x_imax',     'IMAX',       /\bimax\b/i],
        ['x_matte',    'Open Matte', /\bopen[-\s]?matte\b/i],
        ['x_ext',      'Extended',   /\bextended\b/i],
        ['x_dc',       "Director's Cut", /\bdirector'?s[-\s]?cut\b/i],
        ['x_unrated',  'Unrated',    /\bunrated\b/i],
        ['x_proper',   'Proper',     /\bproper\b/i],
        ['x_repack',   'REPACK',     /\brepack\b/i],
        ['x_3d',       '3D',         /\b3d\b/i],
        ['x_hfr',      'HFR',        /\b(?:60\s?fps|hfr)\b/i],

        // ── resolution (fallback only) ──────────────────────────────────
        ['res', '2160p',      /\b(?:2160[pi]|4k|uhd)\b/i],
        ['res', '1440p',      /\b1440[pi]\b/i],
        ['res', '1080p',      /\b1080[pi]\b/i],
        ['res', '720p',       /\b720[pi]\b/i],
        ['res', '480p',       /\b480[pi]\b/i]
    ];

    // Synonyms used to drop duplicates.
    // The balancer writes "H.265" where we write "x265", and shows a "4K"
    // badge where we write "2160p". Without this the card would carry the
    // same fact twice. Careful with short synonyms: "hd" would match
    // inside "HDR" and "sd" inside "SDR", so neither is listed here.
    var ALIASES = {
        'x265':         ['x265', 'h.265', 'h265', 'hevc'],
        'x264':         ['x264', 'h.264', 'h264', 'avc'],
        'Dolby Vision': ['dolby vision', 'dovi'],
        '2160p':        ['2160p', '4k', 'uhd'],
        '1440p':        ['1440p', '2k'],
        '1080p':        ['1080p', 'fhd'],
        'DD+':          ['dd+', 'ddp', 'eac3', 'e-ac3'],
        'AC3':          ['ac3', 'ac-3', 'dolby digital']
    };

    function alreadyShown(label, text) {
        var list = ALIASES[label] || [label.toLowerCase()];

        for (var i = 0; i < list.length; i++) {
            if (text.indexOf(list[i]) !== -1) return true;
        }

        return false;
    }

    // Order of groups on the card.
    var ORDER = ['rip', 'res', 'codec', 'depth', 'dv', 'hdr',
                 'atmos', 'audio', 'ch',
                 'x_imax', 'x_matte', 'x_ext', 'x_dc', 'x_unrated',
                 'x_proper', 'x_repack', 'x_3d', 'x_hfr'];


    // =====================================================================
    //  COLLECT TEXT FROM THE OBJECT
    // =====================================================================
    function harvest(obj, depth, acc) {
        if (obj == null || depth > 3 || acc.join(' ').length > MAX_TEXT) return acc;

        if (typeof obj === 'string') {
            if (obj && obj.indexOf('http') !== 0 && obj.length < 400) acc.push(obj);
            return acc;
        }

        if (typeof obj !== 'object') return acc;

        if (Object.prototype.toString.call(obj) === '[object Array]') {
            for (var i = 0; i < obj.length && i < 30; i++) harvest(obj[i], depth + 1, acc);
            return acc;
        }

        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            if (SKIP_KEYS.indexOf(key.toLowerCase()) !== -1) continue;

            var val = obj[key];

            if (typeof val === 'string') {
                if (val && val.indexOf('http') !== 0 && val.length < 400) acc.push(val);
            }
            else if (typeof val === 'object' && val !== null) {
                harvest(val, depth + 1, acc);
            }
        }

        return acc;
    }


    // =====================================================================
    //  PARSE
    // =====================================================================
    function parse(text) {
        var found = {};

        for (var i = 0; i < RULES.length; i++) {
            var group = RULES[i][0];
            var label = RULES[i][1];
            var re    = RULES[i][2];

            if (found[group]) continue;            // group already matched
            if (re.test(text)) found[group] = label;
        }

        var tags = [];

        ORDER.forEach(function (group) {
            if (found[group]) tags.push({ group: group, label: found[group] });
        });

        return tags;
    }


    // =====================================================================
    //  STYLES
    // =====================================================================
    function registerStyles() {
        Lampa.Template.add(ID + '_style', '<style>'
            + '.omi-tags{display:flex;flex-wrap:wrap;align-items:center;'
            + 'margin:.4em -.2em 0 -.2em;line-height:1}'
            + '.omi-tag{margin:.2em;padding:.25em .5em;border-radius:.3em;'
            + 'font-size:.82em;font-weight:600;white-space:nowrap;'
            + 'background:rgba(255,255,255,.12);color:rgba(255,255,255,.85)}'
            + '.omi-tag--rip{background:rgba(66,165,245,.22);color:#8ec6ff}'
            + '.omi-tag--res{background:rgba(255,255,255,.16)}'
            + '.omi-tag--codec{background:rgba(255,255,255,.10)}'
            + '.omi-tag--depth{background:rgba(255,255,255,.10)}'
            + '.omi-tag--dv{background:rgba(156,39,176,.28);color:#e1a7ff}'
            + '.omi-tag--hdr{background:rgba(255,160,0,.24);color:#ffd08a}'
            + '.omi-tag--atmos{background:rgba(56,165,100,.26);color:#8fe0b0}'
            + '.omi-tag--audio{background:rgba(56,165,100,.18);color:#8fe0b0}'
            + '.omi-tag--ch{background:rgba(56,165,100,.12);color:#8fe0b0}'
            + '.omi-tag--debug{background:rgba(255,87,34,.22);color:#ffb599;'
            + 'font-weight:400;white-space:normal}'
            + '.omi-tags .omi-tag[class*="omi-tag--x_"]'
            + '{background:rgba(255,255,255,.16);color:#fff}'
            + '</style>');

        $('body').append(Lampa.Template.get(ID + '_style', {}, true));
    }


    // =====================================================================
    //  DECORATE A CARD
    // =====================================================================
    function decorate($card, data) {
        if (!$card || !$card.find) return;
        if ($card.find('.omi-tags').length) return;       // already decorated

        var body = null;

        for (var c = 0; c < CONTAINERS.length; c++) {
            var found = $card.find(CONTAINERS[c]);

            if (found.length) { body = found.eq(0); break; }
        }

        if (!body) return;

        var text = harvest(data, 0, []).join('  |  ');
        var tags = parse(text);

        // Do not repeat what the balancer already wrote in its info line,
        // e.g. "2160p / 18.57 GB / HDR / H.265 / Dolby Vision / ↑18".
        var shown = ($card.text() || '').toLowerCase();

        tags = tags.filter(function (t) {
            return !alreadyShown(t.label, shown);
        });

        if (Lampa.Storage.field(ID + '_compact')) tags = tags.slice(0, 4);

        var debug = Lampa.Storage.field(ID + '_debug');

        if (!tags.length && !debug) return;

        var row = $('<div class="omi-tags"></div>');

        tags.forEach(function (t) {
            row.append('<div class="omi-tag omi-tag--' + t.group + '">'
                + t.label + '</div>');
        });

        // Diagnostic mode: show which fields the balancer actually sent.
        // Visible right on the TV, so no DevTools are needed.
        if (debug) {
            var keys = [];

            for (var k in data) {
                if (Object.prototype.hasOwnProperty.call(data, k)) keys.push(k);
            }

            row.append('<div class="omi-tag omi-tag--debug">keys: '
                + keys.join(', ') + '</div>');
            row.append('<div class="omi-tag omi-tag--debug">text: '
                + text.substr(0, 300) + '</div>');
        }

        body.append(row);
    }


    // =====================================================================
    //  Template.get HOOK
    //  Original signature: get(name, vars = {}, like_static = false)
    //  With like_static it returns a string rather than jQuery, so those
    //  calls are skipped.
    // =====================================================================
    function hookTemplate() {
        if (Lampa.Template.get.__omi_hooked) return;

        var original = Lampa.Template.get;

        var wrapped = function (name, vars, like_static) {
            var result = original.apply(this, arguments);

            if (!like_static && typeof name === 'string' && NAME_RE.test(name)
                && Lampa.Storage.field(ID + '_enabled')) {

                seen[name] = (seen[name] || 0) + 1;

                try {
                    decorate(result, vars);
                }
                catch (e) {
                    console.error(LOG, 'decorate fail:', e);
                }
            }

            return result;
        };

        wrapped.__omi_hooked = true;

        Lampa.Template.get = wrapped;
    }


    // =====================================================================
    //  SETTINGS
    // =====================================================================
    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: ID,
            name: 'Online MediaInfo',
            icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
                + '<path d="M3 5h18v14H3z" fill="none" stroke="currentColor" '
                + 'stroke-width="2"/><path d="M7 9h10M7 13h6" '
                + 'stroke="currentColor" stroke-width="2" '
                + 'stroke-linecap="round"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: ID,
            param: { name: ID + '_enabled', type: 'trigger', default: true },
            field: {
                name: 'Увімкнути',
                description: 'Показувати теги на картках розділу «Онлайн»'
            }
        });

        Lampa.SettingsApi.addParam({
            component: ID,
            param: { name: ID + '_compact', type: 'trigger', default: false },
            field: {
                name: 'Компактно',
                description: 'Не більше 4 тегів на картку'
            }
        });

        Lampa.SettingsApi.addParam({
            component: ID,
            param: { name: ID + '_debug', type: 'trigger', default: false },
            field: {
                name: 'Режим діагностики',
                description: 'Показати, які поля прислав балансер. '
                    + 'Вмикай, якщо теги не з\'являються'
            },
            // Surface which templates were actually intercepted. Visible
            // right on the TV and answers immediately whether the hook
            // fired at all: an empty list means the online plugin builds
            // its cards some other way.
            onRender: function (item) {
                var names = [];

                for (var n in seen) {
                    if (Object.prototype.hasOwnProperty.call(seen, n)) {
                        names.push(n + ' ×' + seen[n]);
                    }
                }

                item.find('.settings-param__descr').text(names.length
                    ? 'Перехоплені шаблони: ' + names.join(', ')
                    : 'Шаблонів онлайн-плагіна ще не бачив. Спершу зайди '
                      + 'в «Онлайн», потім повернись сюди');
            }
        });
    }


    // =====================================================================
    //  INIT
    // =====================================================================
    function init() {
        console.log(LOG, 'init v' + VER + ', Lampa', Lampa.Manifest.app_version);

        registerStyles();
        registerSettings();
        hookTemplate();

        Lampa.Manifest.plugins = {
            type: 'other',
            version: VER,
            name: 'Online MediaInfo',
            description: 'Розширені теги відео на картках «Онлайн»'
        };

        console.log(LOG, 'ready');
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') init();
    });
})();
