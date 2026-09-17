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
    var VER = '1.5.0';
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

    // Turn whatever the transport handed back into something readable. The
    // native Android bridge and jQuery report failures differently, and a
    // generic "request failed" hides the one line that names the cause —
    // RD answers with a JSON body such as {"error":"bad_token"}.
    function describe(e) {
        if (!e) return 'відповіді немає';
        if (typeof e === 'string') return e.slice(0, 300);

        var parts = [];

        if (e.status) parts.push('HTTP ' + e.status);

        // jQuery reports responseText/statusText; the Android bridge builds
        // its own object instead — AndroidJS.kt:
        //     putSafe("status", http.lastErrorCode)
        //     putSafe("message", "request error: …")
        // so `message` must be read too, or the device shows a bare status.
        var body = e.responseText || e.message || e.statusText || e.error || '';

        if (body && typeof body === 'object') {
            try { body = JSON.stringify(body); } catch (x) { body = ''; }
        }

        if (body) parts.push((body + '').slice(0, 300));

        if (!parts.length) {
            try { parts.push(JSON.stringify(e).slice(0, 300)); }
            catch (x) { parts.push('невідома помилка'); }
        }

        return parts.join(' · ');
    }

    // One call to the RD API. post_data as a string turns it into a POST;
    // `false` keeps it a GET — that is the convention Lampa itself uses.
    //
    // The token goes in BOTH the Authorization header and the auth_token
    // query parameter. RD accepts either, and sending both removes any
    // dependency on custom headers surviving the trip through the native
    // Android bridge.
    function rdCall(network, path, post_data, ok, err) {
        var url = API + path;

        url += (url.indexOf('?') === -1 ? '?' : '&')
            + 'auth_token=' + encodeURIComponent(token());

        network.native(url, ok, function (e) {
            console.error(LOG, 'request failed:', path, e);
            err(describe(e));
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

    // RD needs a magnet.
    //
    // Public trackers hand one over directly. Private ones (Toloka, for
    // example) only publish a .torrent file — but Jackett and JacRed still
    // report the infohash next to it, and a magnet built from the infohash
    // alone is enough for Real-Debrid: it finds peers itself, so no tracker
    // list is required.
    //
    // NB: element.hash is NOT the infohash. jackett() overwrites it with
    //     element.hash = Utils.hash(element.Title)
    // i.e. a hash of the title. Using it would send RD a bogus torrent.
    function magnetOf(element) {
        var magnet = element.MagnetUri || element.magnet || '';

        if (magnet.indexOf('magnet:') === 0) return magnet;

        var link = element.Link || element.link || '';

        if (link.indexOf('magnet:') === 0) return link;

        var ih = (element.InfoHash || element.infoHash || element.info_hash || '') + '';

        ih = ih.trim();

        // 40 hex chars (btih v1) or 32 base32 chars
        if (/^[a-f0-9]{40}$/i.test(ih) || /^[a-z2-7]{32}$/i.test(ih)) {
            return 'magnet:?xt=urn:btih:' + ih
                + '&dn=' + encodeURIComponent(element.Title || '');
        }

        return '';
    }

    // Used when a release yields no magnet at all: listing the fields the
    // parser actually returned says whether another identifier is available,
    // instead of leaving it at "not supported".
    function fieldsOf(element) {
        var keys = [];

        for (var k in element) {
            if (Object.prototype.hasOwnProperty.call(element, k)) keys.push(k);
        }

        return keys.join(', ');
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
            + '.rdb-head{padding:0 .2em .8em;opacity:.55;font-size:.9em}'
            + '.rdb-status{padding:2em 1em;text-align:center}'
            + '.rdb-status__title{font-size:1.2em;margin-bottom:.8em}'
            + '.rdb-status__stage{font-size:1.6em;font-weight:600;margin-bottom:.6em}'
            + '.rdb-status__descr{opacity:.7}'
            + '.rdb-status__descr--pre{white-space:pre-line;text-align:left;'
            + 'display:inline-block;max-width:40em}'
            + '.rdb-status__bar{height:.4em;border-radius:.2em;margin:1.2em auto 0;'
            + 'max-width:30em;background:rgba(255,255,255,.15);overflow:hidden}'
            + '.rdb-status__bar > div{height:100%;width:0;background:#38a564;'
            + 'transition:width .3s}'
            + '.rdb-status__detail{margin-top:1.2em;opacity:.75;font-size:.9em;'
            + 'color:#ffb599}'
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
        var head    = null;      // header element, also the diagnostics line

        var _this = this;


        // Build the query the way the native Torrents screen does. It does
        // NOT search by movie.title: it combines the original and localised
        // titles with the year according to the parse_lang setting, and a
        // parser tuned for that answers very differently to a bare title.
        function parserQuery() {
            var movie = object.movie || {};
            var year  = ((movie.first_air_date || movie.release_date || '0000') + '').slice(0, 4);
            var orig  = movie.original_title || movie.title || '';
            var local = movie.title || movie.original_title || '';

            var combos = {
                'df':         orig,
                'df_year':    orig + ' ' + year,
                'df_lg':      orig + ' ' + local,
                'df_lg_year': orig + ' ' + local + ' ' + year,
                'lg':         local,
                'lg_year':    local + ' ' + year,
                'lg_df':      local + ' ' + orig,
                'lg_df_year': local + ' ' + orig + ' ' + year
            };

            // jackett() calls params.movie.genres.map(...) unconditionally,
            // so a card without genres would throw. Copy the movie instead
            // of mutating Lampa's own object.
            var safe = {};

            for (var k in movie) {
                if (Object.prototype.hasOwnProperty.call(movie, k)) safe[k] = movie[k];
            }

            if (!safe.genres || !safe.genres.length) safe.genres = [];

            return {
                movie: safe,
                search: combos[Lampa.Storage.field('parse_lang')] || combos.lg_df,
                search_one: local,
                search_two: orig,
                page: 1
            };
        }


        this.create = function () {
            this.activity.loader(true);
            inited = true;

            // The parser the user already set up in Lampa settings. It
            // resolves Jackett / Prowlarr / TorrServer on its own, so there
            // is nothing to reimplement here.
            Lampa.Parser.get(parserQuery(), function (data) {
                if (!inited) return;

                var list = (data && data.Results) ? data.Results : [];

                list.sort(function (a, b) {
                    return (b.Seeders || 0) - (a.Seeders || 0);
                });

                _this.buildList(list);
            }, function (e) {
                if (!inited) return;

                // Show what the parser actually said plus the full parser
                // configuration. Printing only jackett_url was misleading:
                // selectParserLinks() picks the slot by parser_use_link, so
                // with 'two' the first address is irrelevant and an empty
                // one means nothing.
                var reason = (typeof e === 'string' && e) ? e : 'без пояснення';
                var type   = Lampa.Storage.field('parser_torrent_type');

                var shown = function (v) { return v ? v : '(порожньо)'; };

                var lines = [
                    'Парсер не відповів: ' + reason,
                    '',
                    'Тип: ' + type,
                    'Увімкнено (parser_use): ' + Lampa.Storage.field('parser_use'),
                    'Який слот (parser_use_link): '
                        + (Lampa.Storage.field('parser_use_link') || 'one')
                ];

                if (type === 'prowlarr') {
                    lines.push('prowlarr_url: ' + shown(Lampa.Storage.field('prowlarr_url')));
                    lines.push('prowlarr_url_two: ' + shown(Lampa.Storage.field('prowlarr_url_two')));
                }
                else if (type === 'torrserver') {
                    lines.push('torrserver_url: ' + shown(Lampa.Storage.field('torrserver_url')));
                    lines.push('torrserver_url_two: ' + shown(Lampa.Storage.field('torrserver_url_two')));
                }
                else {
                    lines.push('jackett_url: ' + shown(Lampa.Storage.field('jackett_url')));
                    lines.push('jackett_url_two: ' + shown(Lampa.Storage.field('jackett_url_two')));
                }

                lines.push('Запит: ' + parserQuery().search);

                _this.empty(lines.join('\n'));
            });

            return this.render();
        };


        this.buildList = function (list) {
            this.activity.loader(false);

            if (!list.length) return this.empty('Парсер нічого не знайшов');

            state = 'list';

            scroll.clear();
            items = [];

            // Header doubles as diagnostics: which build is actually running
            // and whether the token survived. Both were guessed at otherwise,
            // and a stale cached copy looks exactly like a broken new one.
            var tok = token();

            head = $('<div class="rdb-head"></div>').text(
                'v' + VER
                + ' · токен: ' + (tok ? tok.length + ' симв.' : 'відсутній')
                + ' · релізів: ' + list.length
            );

            scroll.append(head);

            // Ask RD who we are straight away. A bad token otherwise only
            // shows up after picking a release and waiting — this answers it
            // before the first choice, and distinguishes an invalid token
            // (401 bad_token) from a locked account (403).
            this.checkAccount();

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
                        return Lampa.Noty.show('Немає ні magnet, ні InfoHash. '
                            + 'Поля парсера: ' + fieldsOf(element),
                            { time: 12000 });
                    }

                    _this.run(element, magnet);
                });

                items.push(row);
                scroll.append(row);
            });

            this.activity.toggle();
        };


        // GET /user — the cheapest possible proof that the token works.
        // Success also tells premium from free, which matters: a free
        // account authenticates fine but cannot unrestrict anything.
        this.checkAccount = function () {
            if (!token()) return;

            rdCall(network, '/user', false, function (u) {
                if (!inited || !head) return;

                var type = (u && u.type) ? u.type : '?';
                var till = (u && u.expiration)
                    ? ' до ' + (u.expiration + '').slice(0, 10) : '';

                head.text(head.text() + ' · RD: ' + type + till);
            }, function (e) {
                if (!inited || !head) return;

                head.text(head.text() + ' · RD: ' + e);
            });
        };


        this.empty = function (text) {
            this.activity.loader(false);

            state = 'list';

            var box = $('<div class="rdb-status">'
                + '<div class="rdb-status__descr rdb-status__descr--pre"></div></div>');

            // .text() keeps the message safe; --pre makes the newlines in a
            // diagnostic message actually show up.
            box.find('.rdb-status__descr').text(text || 'Порожньо');

            scroll.clear();
            scroll.append(box);

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
                + '<div class="rdb-status__detail rdb-status__descr--pre"></div>'
                + '</div>');

            html.find('.rdb-status__title').text(title);

            scroll.append(html);

            this.stage = function (text, percent) {
                html.find('.rdb-status__stage').text(text);

                if (typeof percent === 'number') {
                    html.find('.rdb-status__bar > div').css('width', percent + '%');
                }
            };

            // Where the server's own words go, instead of being swallowed.
            this.detail = function (text) {
                html.find('.rdb-status__detail').text(text || '');
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
                function (e) {
                    _this.fail('Не вдалося звернутись до Real-Debrid',
                        'addMagnet → ' + e);
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
            }, function (e) {
                _this.fail('Real-Debrid не відповідає', 'info → ' + e);
            });
        };

        this.select = function (file_id) {
            rdCall(network, '/torrents/selectFiles/' + torrent,
                form({ files: file_id }), function () {
                    if (!inited) return;

                    _this.stage('Чекаємо на Real-Debrid…', 0);
                    _this.waitReady(0);
                }, function (e) {
                    _this.fail('Не вдалося вибрати файл', 'selectFiles → ' + e);
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
            }, function (e) {
                _this.fail('Real-Debrid не відповідає', 'info → ' + e);
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
                }, function (e) {
                    _this.fail('Не вдалося отримати пряме посилання',
                        'unrestrict → ' + e);
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

        this.fail = function (text, detail) {
            console.warn(LOG, text, detail || '');

            Lampa.Noty.show(text, { time: 8000 });

            if (this.stage)  this.stage('Не вдалося');
            if (this.detail) this.detail(detail || '');
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
            // `placeholder` is required too: the row template interpolates
            // placeholder="${data.param.placeholder}" verbatim, so omitting
            // it puts the literal string "undefined" in the attribute, and
            // update() then shows "undefined" as the field value.
            param: {
                name: ID + '_token',
                type: 'input',
                values: '',
                default: '',
                placeholder: 'Вставити токен'
            },
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
