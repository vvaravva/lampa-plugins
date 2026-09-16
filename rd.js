(function () {
    'use strict';

    // =====================================================================
    //  Real-Debrid for Lampa — play a release through RD instead of
    //  downloading it with TorrServer.
    //
    //  FLOW
    //    card button → own screen → Lampa.Parser.get() (the parser the user
    //    already configured) → pick a release → RD chain → Lampa.Player
    //
    //  RD CHAIN
    //    POST /torrents/addMagnet        → id
    //    GET  /torrents/info/{id}        → wait for waiting_files_selection
    //    POST /torrents/selectFiles/{id} → the largest video file
    //    GET  /torrents/info/{id}        → poll until status == downloaded
    //    POST /unrestrict/link           → direct https link
    //    Lampa.Player.play({url})
    //
    //  WHY Reguest.native AND NOT fetch
    //  api.real-debrid.com sends no Access-Control-Allow-Origin, so a plain
    //  XHR from the page is blocked by CORS. Lampa's own reguest.js routes
    //  .native() through the Android bridge (AndroidJS.httpReq) where CORS
    //  does not apply:
    //      function native(params){
    //          if(Platform.is('android')) android_go(params)
    //          else go(params)
    //      }
    //  Consequence: this plugin works in the LAMPA Android app. In a plain
    //  browser, on webOS and on Tizen it will not — that is a hard limit,
    //  not a bug.
    //
    //  SCOPE: movies only. Series need season/episode matching inside the
    //  torrent and a playlist, which is a different job.
    // =====================================================================

    var ID  = 'rdb';
    var VER = '1.0.0';
    var LOG = '[real-debrid]';
    var API = 'https://api.real-debrid.com/rest/1.0';

    var POLL_MS   = 2000;   // how often to ask RD for torrent status
    var POLL_MAX  = 900;    // give up after ~30 minutes of waiting

    var VIDEO_EXT = ['mkv', 'mp4', 'avi', 'm4v', 'mov', 'ts', 'm2ts', 'wmv', 'mpg', 'mpeg'];

    if (window.plugin_rdb_ready) return;
    window.plugin_rdb_ready = true;


    // =====================================================================
    //  HELPERS
    // =====================================================================
    function token() {
        return (Lampa.Storage.get(ID + '_token', '') + '').trim();
    }

    // One call to the RD API. post_data as a string turns it into a POST;
    // `false` keeps it a GET — that is the convention Lampa itself uses.
    function rdCall(network, path, post_data, ok, err) {
        network.native(API + path, ok, function (e) {
            console.error(LOG, 'request failed:', path, e);
            err(e);
        }, post_data, {
            headers: { Authorization: 'Bearer ' + token() },
            dataType: 'json',
            timeout: 20000
        });
    }

    function form(obj) {
        var parts = [];

        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
                parts.push(k + '=' + encodeURIComponent(obj[k]));
            }
        }

        return parts.join('&');
    }

    // RD needs a magnet. Parsers usually provide one; some only give a link
    // to a .torrent file, which would need a binary upload — out of scope.
    function magnetOf(element) {
        var magnet = element.MagnetUri || element.magnet || '';

        if (magnet.indexOf('magnet:') === 0) return magnet;

        var link = element.Link || element.link || '';

        if (link.indexOf('magnet:') === 0) return link;

        return '';
    }

    function biggestVideo(files) {
        var best = null;

        (files || []).forEach(function (f) {
            var ext = (f.path || '').split('.').pop().toLowerCase();

            if (VIDEO_EXT.indexOf(ext) === -1) return;
            if (!best || f.bytes > best.bytes) best = f;
        });

        return best;
    }

    function human(bytes) {
        return Lampa.Utils.bytesToSize ? Lampa.Utils.bytesToSize(bytes) : bytes + ' B';
    }


    // =====================================================================
    //  STYLES
    // =====================================================================
    function registerStyles() {
        Lampa.Template.add(ID + '_style', '<style>'
            + '.rdb-item{position:relative;padding:1em;margin-bottom:.6em;'
            + 'border-radius:.4em;background:rgba(255,255,255,.08)}'
            + '.rdb-item.focus{background:#fff;color:#000}'
            + '.rdb-item__title{font-size:1.05em;line-height:1.3;margin-bottom:.5em}'
            + '.rdb-item__meta{display:flex;flex-wrap:wrap;opacity:.7;font-size:.9em}'
            + '.rdb-item__meta > *{margin-right:1.2em}'
            + '.rdb-status{padding:2em 1em;text-align:center}'
            + '.rdb-status__title{font-size:1.2em;margin-bottom:.8em}'
            + '.rdb-status__stage{font-size:1.6em;font-weight:600;margin-bottom:.6em}'
            + '.rdb-status__descr{opacity:.7}'
            + '.rdb-status__bar{height:.4em;border-radius:.2em;margin:1.2em auto 0;'
            + 'max-width:30em;background:rgba(255,255,255,.15);overflow:hidden}'
            + '.rdb-status__bar > div{height:100%;width:0;background:#38a564;'
            + 'transition:width .3s}'
            + '</style>');

        $('body').append(Lampa.Template.get(ID + '_style', {}, true));
    }


    // =====================================================================
    //  SCREEN
    // =====================================================================
    function Component(object) {
        var network = new Lampa.Reguest();
        var scroll  = new Lampa.Scroll({ mask: true, over: true });
        var items   = [];
        var last    = false;
        var inited  = false;

        var state   = 'list';    // 'list' | 'work'
        var timer   = null;      // poll timeout id
        var torrent = null;      // id of the torrent added to RD

        var _this = this;


        this.create = function () {
            this.activity.loader(true);
            inited = true;

            // The parser the user already set up in Lampa settings. It
            // resolves Jackett / Prowlarr / TorrServer on its own, so there
            // is nothing to reimplement here.
            Lampa.Parser.get(object, function (data) {
                if (!inited) return;

                var list = (data && data.Results) ? data.Results : [];

                list.sort(function (a, b) {
                    return (b.Seeders || 0) - (a.Seeders || 0);
                });

                _this.buildList(list);
            }, function () {
                if (inited) _this.empty('Парсер не відповів');
            });

            return this.render();
        };


        this.buildList = function (list) {
            this.activity.loader(false);

            if (!list.length) return this.empty('Парсер нічого не знайшов');

            state = 'list';

            scroll.clear();
            items = [];

            list.forEach(function (element) {
                var magnet = magnetOf(element);

                var row = $('<div class="rdb-item selector">'
                    + '<div class="rdb-item__title"></div>'
                    + '<div class="rdb-item__meta">'
                    + '<div>' + (element.size || human(element.Size || 0)) + '</div>'
                    + '<div>↑ ' + (element.Seeders || 0) + '</div>'
                    + '<div>' + (element.Tracker || '') + '</div>'
                    + (magnet ? '' : '<div>без magnet</div>')
                    + '</div></div>');

                // .text() so a release name can never inject markup
                row.find('.rdb-item__title').text(element.Title || '');

                row.on('hover:focus', function (e) {
                    last = e.target;
                    scroll.update($(e.target), true);
                });

                row.on('hover:enter', function () {
                    if (!token()) {
                        return Lampa.Noty.show('Спершу вкажи токен у '
                            + 'Налаштування → Real-Debrid');
                    }

                    if (!magnet) {
                        return Lampa.Noty.show('У цього релізу немає magnet — '
                            + 'Real-Debrid його не прийме');
                    }

                    _this.run(element, magnet);
                });

                items.push(row);
                scroll.append(row);
            });

            this.activity.toggle();
        };


        this.empty = function (text) {
            this.activity.loader(false);

            scroll.clear();
            scroll.append($('<div class="rdb-status"><div class="rdb-status__descr"></div></div>')
                .find('.rdb-status__descr').text(text || 'Порожньо').end());

            this.activity.toggle();
        };


        // ── status screen ───────────────────────────────────────────────
        this.showStatus = function (title) {
            state = 'work';

            scroll.clear();

            var html = $('<div class="rdb-status">'
                + '<div class="rdb-status__title"></div>'
                + '<div class="rdb-status__stage">Додаємо в Real-Debrid…</div>'
                + '<div class="rdb-status__descr">Назад — скасувати</div>'
                + '<div class="rdb-status__bar"><div></div></div>'
                + '</div>');

            html.find('.rdb-status__title').text(title);

            scroll.append(html);

            this.stage = function (text, percent) {
                html.find('.rdb-status__stage').text(text);

                if (typeof percent === 'number') {
                    html.find('.rdb-status__bar > div').css('width', percent + '%');
                }
            };

            Lampa.Controller.collectionSet(scroll.render());
        };


        // ── the RD chain ────────────────────────────────────────────────
        this.run = function (element, magnet) {
            this.showStatus(element.Title || '');

            rdCall(network, '/torrents/addMagnet', form({ magnet: magnet }),
                function (json) {
                    if (!inited) return;

                    if (!json || !json.id) return _this.fail('Real-Debrid не '
                        + 'прийняв magnet');

                    torrent = json.id;

                    _this.stage('Читаємо список файлів…');
                    _this.waitFiles(0);
                },
                function () {
                    _this.fail('Не вдалося звернутись до Real-Debrid. '
                        + 'Перевір токен і мережу');
                });
        };

        // Wait until RD has resolved the magnet and knows the file list.
        this.waitFiles = function (tick) {
            if (!inited) return;
            if (tick > POLL_MAX) return _this.fail('Real-Debrid надто довго '
                + 'обробляє цю роздачу');

            rdCall(network, '/torrents/info/' + torrent, false, function (info) {
                if (!inited) return;

                if (info.status === 'magnet_error' || info.status === 'error'
                    || info.status === 'virus' || info.status === 'dead') {
                    return _this.fail('Real-Debrid відхилив роздачу: ' + info.status);
                }

                if (info.files && info.files.length) {
                    var file = biggestVideo(info.files);

                    if (!file) return _this.fail('У роздачі немає відеофайлу');

                    _this.stage('Обрано файл ' + human(file.bytes));
                    _this.select(file.id);

                    return;
                }

                _this.stage('Розбираємо magnet…');
                timer = setTimeout(function () { _this.waitFiles(tick + 1); }, POLL_MS);
            }, function () {
                _this.fail('Real-Debrid не відповідає');
            });
        };

        this.select = function (file_id) {
            rdCall(network, '/torrents/selectFiles/' + torrent,
                form({ files: file_id }), function () {
                    if (!inited) return;

                    _this.stage('Чекаємо на Real-Debrid…', 0);
                    _this.waitReady(0);
                }, function () {
                    _this.fail('Не вдалося вибрати файл');
                });
        };

        // Poll until the file is ready. If the release is already in RD's
        // cache this returns almost immediately; if not, RD downloads it
        // first and progress climbs from 0.
        this.waitReady = function (tick) {
            if (!inited) return;
            if (tick > POLL_MAX) return _this.fail('Завантаження в Real-Debrid '
                + 'триває надто довго');

            rdCall(network, '/torrents/info/' + torrent, false, function (info) {
                if (!inited) return;

                if (info.status === 'error' || info.status === 'virus'
                    || info.status === 'dead') {
                    return _this.fail('Real-Debrid зупинився: ' + info.status);
                }

                if (info.status === 'downloaded' && info.links && info.links.length) {
                    _this.stage('Отримуємо посилання…', 100);
                    _this.unrestrict(info.links[0]);

                    return;
                }

                var percent = typeof info.progress === 'number' ? info.progress : 0;

                if (info.status === 'downloading') {
                    _this.stage('Real-Debrid завантажує: '
                        + Math.round(percent) + '%', percent);
                }
                else {
                    _this.stage('Статус: ' + info.status, percent);
                }

                timer = setTimeout(function () { _this.waitReady(tick + 1); }, POLL_MS);
            }, function () {
                _this.fail('Real-Debrid не відповідає');
            });
        };

        this.unrestrict = function (link) {
            rdCall(network, '/unrestrict/link', form({ link: link }),
                function (json) {
                    if (!inited) return;

                    if (!json || !json.download) {
                        return _this.fail('Real-Debrid не віддав пряме посилання');
                    }

                    _this.play(json.download, json.filename || object.title);
                }, function () {
                    _this.fail('Не вдалося отримати пряме посилання');
                });
        };

        this.play = function (url, title) {
            var item = {
                url: url,
                title: title || (object.movie ? object.movie.title : ''),
                timeline: object.movie
                    ? Lampa.Timeline.view(Lampa.Utils.hash(object.movie.original_title || title))
                    : undefined
            };

            Lampa.Player.play(item);
            Lampa.Player.playlist([item]);

            _this.stage('Запускаємо…', 100);
        };

        this.fail = function (text) {
            console.warn(LOG, text);

            Lampa.Noty.show(text, { time: 6000 });

            if (this.stage) this.stage('Не вдалося');
        };

        this.cancel = function () {
            clearTimeout(timer);
            timer = null;
            network.clear();
        };


        // ── lifecycle ───────────────────────────────────────────────────
        this.start = function () {
            if (Lampa.Activity.active().activity !== this.activity) return;

            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () { Navigator.move('right'); },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    if (Navigator.canmove('down')) Navigator.move('down');
                },
                back: function () {
                    // While RD is working, Back cancels and returns to the
                    // list instead of leaving the screen entirely.
                    if (state === 'work') {
                        _this.cancel();
                        _this.create();
                        Lampa.Controller.toggle('content');
                    }
                    else Lampa.Activity.backward();
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause  = function () {};
        this.stop   = function () {};

        this.destroy = function () {
            inited = false;
            this.cancel();
            items = [];
            scroll.destroy();
        };

        this.render = function (js) {
            return js ? scroll.render(true) : scroll.render();
        };
    }


    // =====================================================================
    //  CARD BUTTON
    // =====================================================================
    function addCardButton() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;

            var movie = e.data.movie;

            // Movies only for now — a series needs episode matching.
            if (!movie || movie.name) return;

            var render = e.object.activity.render();

            if (render.find('.view--rdb').length) return;

            var btn = $('<div class="full-start__button selector view--rdb">'
                + '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
                + '<path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>'
                + '<span>Real-Debrid</span></div>');

            btn.on('hover:enter', function () {
                Lampa.Activity.push({
                    url: '',
                    title: 'Real-Debrid',
                    component: ID,
                    movie: movie,
                    search: movie.title,
                    page: 1
                });
            });

            var anchor = render.find('.view--torrent');

            if (anchor.length) anchor.after(btn);
            else render.find('.full-start-new__buttons, .full-start__buttons')
                       .eq(0).append(btn);
        });
    }


    // =====================================================================
    //  SETTINGS
    // =====================================================================
    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: ID,
            name: 'Real-Debrid',
            icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
                + '<path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="currentColor"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: ID,
            // `values` must be a STRING for type:'input'. The settings
            // renderer does:
            //     typeof values[name] == 'string'
            //         ? key
            //         : values[name][key] || values[name][defaults[name]]
            // so leaving it out makes values[name] undefined and the screen
            // dies with "Cannot read properties of undefined (reading '')".
            // Core Lampa declares its own text fields the same way:
            // select('jackett_url','',''). The official docs example omits
            // this — the docs are wrong.
            param: { name: ID + '_token', type: 'input', values: '', default: '' },
            field: {
                name: 'API-токен',
                description: 'Взяти на real-debrid.com/apitoken'
            }
        });
    }


    // =====================================================================
    //  INIT
    // =====================================================================
    function init() {
        console.log(LOG, 'init v' + VER + ', Lampa', Lampa.Manifest.app_version);

        if (!Lampa.Platform.is('android')) {
            console.warn(LOG, 'not android — RD requests will be blocked by CORS');
        }

        registerStyles();
        registerSettings();

        Lampa.Component.add(ID, Component);

        addCardButton();

        Lampa.Manifest.plugins = {
            type: 'video',
            version: VER,
            name: 'Real-Debrid',
            description: 'Відтворення релізів через Real-Debrid',
            component: ID
        };

        console.log(LOG, 'ready');
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') init();
    });
})();
