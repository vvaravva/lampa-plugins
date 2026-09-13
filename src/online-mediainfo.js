(function () {
    'use strict';

    // =====================================================================
    //  Online MediaInfo — розширені теги на картках розділу «Онлайн»
    //
    //  Додає до картки теги, яких немає в стандартному рядку балансера:
    //  тип ріпу (BDRemux / WEB-DL / BDRip…), Dolby Vision, HDR10+,
    //  кодек (x265 / AV1), глибина (10bit), аудіо (Atmos / DTS-HD MA),
    //  канали (7.1 / 5.1) та мітки релізу (IMAX, Extended, Proper…).
    //
    //  ЯК ПРАЦЮЄ
    //  Онлайн-плагін Lampac малює картку через
    //      Lampa.Template.get('lampac_prestige_full', element)
    //  де element — сирий об'єкт від балансера. Плагін обгортає
    //  Template.get, тому отримує і готову картку, і всі поля element.
    //  Своїх подій Lampac не шле, а MutationObserver ламався б від
    //  будь-якої зміни верстки — цей хук стабільніший.
    //
    //  ДЖЕРЕЛО ДАНИХ
    //  Назва релізу може лежати в різних полях залежно від балансера
    //  (title, text, details, name…), тому плагін склеює ВСІ рядкові
    //  поля element і шукає токени по них. Хибне спрацювання майже
    //  виключене — матчаться тільки відомі технічні позначки.
    //
    //  ЯКЩО ТЕГІВ НЕМАЄ — увімкни «Режим діагностики» в налаштуваннях:
    //  на картці з'явиться список полів, які реально прислав балансер.
    // =====================================================================

    var ID  = 'omi';
    var VER = '1.0.0';
    var LOG = '[online-mediainfo]';

    if (window.plugin_omi_ready) return;
    window.plugin_omi_ready = true;

    // Шаблони карток, які декоруємо.
    var TARGETS = [
        'lampac_prestige_full',     // Lampac prestige — основна картка
        'lampac_prestige_folder',   // Lampac prestige — тека/сезон
        'online',                   // старий бандловий online-плагін
        'online_folder'
    ];

    // Поля, які не парсимо: посилання, картинки, службове.
    var SKIP_KEYS = [
        'url', 'link', 'stream', 'file', 'href', 'img', 'image', 'poster',
        'poster_path', 'backdrop_path', 'profile_path', 'hash', 'method',
        'timeline', 'subtitles', 'id', 'iframe'
    ];

    var MAX_TEXT = 2000;


    // =====================================================================
    //  ПРАВИЛА РОЗБОРУ
    //  [група, підпис, регулярка]
    //  Усередині однієї групи спрацьовує ПЕРШЕ правило — тому
    //  довші/специфічніші йдуть раніше (HDR10+ перед HDR10 перед HDR,
    //  DTS-HD MA перед DTS-HD перед DTS, WEB-DLRip перед WEB-DL).
    // =====================================================================
    var RULES = [
        // ── джерело / тип ріпу ──────────────────────────────────────────
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

        // ── Dolby Vision (окрема група — бо йде разом з HDR10) ──────────
        // \bDV\b свідомо без прапорця i: у нижньому регістрі "dv"
        // надто часто трапляється в назвах реліз-груп.
        ['dv',  'Dolby Vision', /\b(?:dolby[-\s]?vision|dovi)\b/i],
        ['dv',  'Dolby Vision', /\bDV\b/],

        // ── HDR ─────────────────────────────────────────────────────────
        ['hdr', 'HDR10+',     /\bhdr[-\s]?10[-\s]?\+|\bhdr10plus\b/i],
        ['hdr', 'HDR10',      /\bhdr[-\s]?10\b/i],
        ['hdr', 'HLG',        /\bhlg\b/i],
        ['hdr', 'HDR',        /\bhdr\b/i],
        ['hdr', 'SDR',        /\bsdr\b/i],

        // ── відеокодек ──────────────────────────────────────────────────
        ['codec', 'AV1',      /\bav1\b/i],
        ['codec', 'x265',     /\b(?:x[-\s]?265|h\.?[-\s]?265|hevc)\b/i],
        ['codec', 'x264',     /\b(?:x[-\s]?264|h\.?[-\s]?264|avc)\b/i],
        ['codec', 'XviD',     /\b(?:xvid|divx)\b/i],

        // ── глибина кольору ─────────────────────────────────────────────
        ['depth', '12bit',    /\b12[-\s]?bits?\b/i],
        ['depth', '10bit',    /\b10[-\s]?bits?\b/i],

        // ── Atmos окремо: йде поверх TrueHD / DD+ ───────────────────────
        ['atmos', 'Atmos',    /\batmos\b/i],

        // ── аудіокодек ──────────────────────────────────────────────────
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

        // ── канали ──────────────────────────────────────────────────────
        ['ch', '7.1',         /\b7\.1\b/],
        ['ch', '5.1',         /\b5\.1\b/],
        ['ch', '2.0',         /\b2\.0\b/],

        // ── мітки релізу (кожна своя група — показуємо всі) ─────────────
        ['x_imax',     'IMAX',       /\bimax\b/i],
        ['x_matte',    'Open Matte', /\bopen[-\s]?matte\b/i],
        ['x_ext',      'Extended',   /\bextended\b/i],
        ['x_dc',       "Director's Cut", /\bdirector'?s[-\s]?cut\b/i],
        ['x_unrated',  'Unrated',    /\bunrated\b/i],
        ['x_proper',   'Proper',     /\bproper\b/i],
        ['x_repack',   'REPACK',     /\brepack\b/i],
        ['x_3d',       '3D',         /\b3d\b/i],
        ['x_hfr',      'HFR',        /\b(?:60\s?fps|hfr)\b/i],

        // ── роздільна здатність (запасний варіант) ──────────────────────
        ['res', '2160p',      /\b(?:2160[pi]|4k|uhd)\b/i],
        ['res', '1440p',      /\b1440[pi]\b/i],
        ['res', '1080p',      /\b1080[pi]\b/i],
        ['res', '720p',       /\b720[pi]\b/i],
        ['res', '480p',       /\b480[pi]\b/i]
    ];

    // Порядок груп на картці.
    var ORDER = ['rip', 'res', 'codec', 'depth', 'dv', 'hdr',
                 'atmos', 'audio', 'ch',
                 'x_imax', 'x_matte', 'x_ext', 'x_dc', 'x_unrated',
                 'x_proper', 'x_repack', 'x_3d', 'x_hfr'];


    // =====================================================================
    //  ЗБІР ТЕКСТУ З ОБ'ЄКТА
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
    //  РОЗБІР
    // =====================================================================
    function parse(text) {
        var found = {};

        for (var i = 0; i < RULES.length; i++) {
            var group = RULES[i][0];
            var label = RULES[i][1];
            var re    = RULES[i][2];

            if (found[group]) continue;            // в групі вже є збіг
            if (re.test(text)) found[group] = label;
        }

        var tags = [];

        ORDER.forEach(function (group) {
            if (found[group]) tags.push({ group: group, label: found[group] });
        });

        return tags;
    }


    // =====================================================================
    //  СТИЛІ
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
    //  ДЕКОРУВАННЯ КАРТКИ
    // =====================================================================
    function decorate($card, data) {
        if (!$card || !$card.find) return;
        if ($card.find('.omi-tags').length) return;       // вже декоровано

        // куди вставляти: prestige-верстка або стара online-верстка
        var body = $card.find('.online-prestige__body');

        if (!body.length) body = $card.find('.online__body');
        if (!body.length) return;

        var text = harvest(data, 0, []).join('  |  ');
        var tags = parse(text);

        // Не дублюємо те, що балансер уже написав у рядку info
        // (наприклад «2160p» та «SDR» у «2160p / 6.89 GB / SDR / ↑21»).
        var shown = ($card.text() || '').toLowerCase();

        tags = tags.filter(function (t) {
            return shown.indexOf(t.label.toLowerCase()) === -1;
        });

        if (Lampa.Storage.field(ID + '_compact')) tags = tags.slice(0, 4);

        var debug = Lampa.Storage.field(ID + '_debug');

        if (!tags.length && !debug) return;

        var row = $('<div class="omi-tags"></div>');

        tags.forEach(function (t) {
            row.append('<div class="omi-tag omi-tag--' + t.group + '">'
                + t.label + '</div>');
        });

        // Режим діагностики: показуємо, які поля реально прислав балансер.
        // Видно прямо на телевізорі — не треба DevTools.
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
    //  ХУК Template.get
    //  Сигнатура оригіналу: get(name, vars = {}, like_static = false)
    //  При like_static повертається рядок, не jQuery — такі виклики
    //  пропускаємо.
    // =====================================================================
    function hookTemplate() {
        if (Lampa.Template.get.__omi_hooked) return;

        var original = Lampa.Template.get;

        var wrapped = function (name, vars, like_static) {
            var result = original.apply(this, arguments);

            if (!like_static && TARGETS.indexOf(name) !== -1
                && Lampa.Storage.field(ID + '_enabled')) {
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
    //  НАЛАШТУВАННЯ
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
            }
        });
    }


    // =====================================================================
    //  ІНІЦІАЛІЗАЦІЯ
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
