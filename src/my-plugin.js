(function () {
    'use strict';

    // =====================================================================
    //  Скелет плагіна Lampa
    //  Демонструє всі основні точки розширення:
    //    1. локалізація         5. власний екран (Activity-компонент)
    //    2. стилі               6. пункт бокового меню
    //    3. маніфест            7. кнопка на картці фільму
    //    4. налаштування        8. ініціалізація
    //
    //  Перед правкою прочитай ../docs/ru/01-getting-started.md
    // =====================================================================

    var ID  = 'myplug';                 // унікальний префікс для всього
    var VER = '1.0.0';
    var LOG = '[' + ID + ']';

    // ── ЗАХИСТ 1: подвійне завантаження ─────────────────────────────────
    // Lampa може виконати скрипт двічі (перевстановлення, дубль URL).
    // Без цього будуть дублі пунктів меню й обробників.
    if (window.plugin_myplug_ready) return;
    window.plugin_myplug_ready = true;


    // =====================================================================
    //  1. ЛОКАЛІЗАЦІЯ
    // =====================================================================
    function registerLang() {
        Lampa.Lang.add({
            myplug_title: {
                uk: 'Мій плагін', ru: 'Мой плагин', en: 'My Plugin'
            },
            myplug_menu: {
                uk: 'Мій плагін', ru: 'Мой плагин', en: 'My Plugin'
            },
            myplug_card_button: {
                uk: 'Мій плагін', ru: 'Мой плагин', en: 'My Plugin'
            },
            myplug_settings_enabled: {
                uk: 'Увімкнути плагін', ru: 'Включить плагин', en: 'Enable plugin'
            },
            myplug_settings_enabled_descr: {
                uk: 'Показувати пункт меню та кнопку на картці',
                ru: 'Показывать пункт меню и кнопку на карточке',
                en: 'Show menu item and card button'
            },
            myplug_settings_mode: {
                uk: 'Режим роботи', ru: 'Режим работы', en: 'Mode'
            },
            myplug_settings_server: {
                uk: 'Адреса сервера', ru: 'Адрес сервера', en: 'Server address'
            },
            myplug_settings_server_descr: {
                uk: 'Наприклад http://192.168.1.10:8090',
                ru: 'Например http://192.168.1.10:8090',
                en: 'For example http://192.168.1.10:8090'
            },
            myplug_empty: {
                uk: 'Нічого не знайдено', ru: 'Ничего не найдено', en: 'Nothing found'
            }
        });
    }


    // =====================================================================
    //  2. СТИЛІ
    //  CSS вбудовується рядком і додається в body. Тільки всередині init().
    // =====================================================================
    function registerStyles() {
        Lampa.Template.add(ID + '_style', '<style>'
            + '.myplug-head{padding:0 0 1.2em 0;font-size:1.4em;font-weight:600}'
            + '.myplug-grid{display:flex;flex-wrap:wrap;margin:0 -0.6em}'
            + '.myplug-grid .card{margin:0 0.6em 1.4em 0.6em}'
            + '.myplug-note{padding:1em;opacity:.6}'
            + '</style>');

        $('body').append(Lampa.Template.get(ID + '_style', {}, true));
    }


    // =====================================================================
    //  3. МАНІФЕСТ
    //  Реєструє плагін у застосунку.
    // =====================================================================
    function registerManifest() {
        Lampa.Manifest.plugins = {
            type: 'other',
            version: VER,
            name: Lampa.Lang.translate('myplug_title'),
            description: 'Скелет плагіна',
            component: ID
        };
    }


    // =====================================================================
    //  4. НАЛАШТУВАННЯ
    //  Розділ у Налаштуваннях. Читання значень — Lampa.Storage.field(key).
    // =====================================================================
    function registerSettings() {
        Lampa.SettingsApi.addComponent({
            component: ID,
            name: Lampa.Lang.translate('myplug_title'),
            icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
                + '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" '
                + 'fill="none" stroke="currentColor" stroke-width="2" '
                + 'stroke-linecap="round" stroke-linejoin="round"/></svg>'
        });

        // trigger — перемикач
        Lampa.SettingsApi.addParam({
            component: ID,
            param: { name: ID + '_enabled', type: 'trigger', default: true },
            field: {
                name: Lampa.Lang.translate('myplug_settings_enabled'),
                description: Lampa.Lang.translate('myplug_settings_enabled_descr')
            },
            onChange: function (value) {
                console.log(LOG, 'enabled ->', value);
            }
        });

        // select — список варіантів
        Lampa.SettingsApi.addParam({
            component: ID,
            param: {
                name: ID + '_mode',
                type: 'select',
                values: { auto: 'Авто', fast: 'Швидко', full: 'Повністю' },
                default: 'auto'
            },
            field: { name: Lampa.Lang.translate('myplug_settings_mode') }
        });

        // input — текстове поле
        Lampa.SettingsApi.addParam({
            component: ID,
            param: { name: ID + '_server', type: 'input', default: '' },
            field: {
                name: Lampa.Lang.translate('myplug_settings_server'),
                description: Lampa.Lang.translate('myplug_settings_server_descr')
            }
        });
    }

    function enabled() {
        return Lampa.Storage.field(ID + '_enabled');
    }


    // =====================================================================
    //  5. ВЛАСНИЙ ЕКРАН (Activity-компонент)
    //  Контракт: create / start / pause / stop / destroy / render.
    //  create() має СИНХРОННО повернути DOM-елемент.
    // =====================================================================
    function Screen(object) {
        var network = new Lampa.Reguest();
        var scroll  = new Lampa.Scroll({ mask: true, over: true });
        var grid    = $('<div class="myplug-grid"></div>');
        var items   = [];
        var last    = false;
        var inited  = false;   // захист від відповіді, що прийшла після destroy

        this.create = function () {
            this.activity.loader(true);
            inited = true;

            scroll.append($('<div class="myplug-head">'
                + Lampa.Lang.translate('myplug_title') + '</div>'));
            scroll.append(grid);

            // Приклад реального запиту. Заміни на свій ендпоінт.
            var url = Lampa.TMDB.api('movie/popular'
                + '?api_key=' + Lampa.TMDB.key()
                + '&language=' + Lampa.Storage.field('language')
                + '&page=' + (object.page || 1));

            network.silent(url, this.build.bind(this), this.empty.bind(this));

            return this.render();
        };

        this.build = function (data) {
            if (!inited) return;                      // компонент уже знищено
            if (!data || !data.results || !data.results.length) return this.empty();

            this.activity.loader(false);

            data.results.forEach(function (element) {
                element.method = element.name ? 'tv' : 'movie';

                var card = new Lampa.Card(element, { card_category: true });

                card.create();
                card.visible();

                card.onFocus = function (target, card_data) {
                    last = target;
                    scroll.update($(target), true);
                    Lampa.Background.change(Lampa.Utils.cardImgBackground(card_data));
                };

                card.onEnter = function (target, card_data) {
                    Lampa.Activity.push({
                        url: '',
                        component: 'full',
                        id: card_data.id,
                        method: card_data.method,
                        card: card_data,
                        source: 'tmdb'
                    });
                };

                items.push(card);
                grid.append(card.render());
            });

            this.activity.toggle();
        };

        this.empty = function () {
            this.activity.loader(false);
            scroll.append($('<div class="myplug-note">'
                + Lampa.Lang.translate('myplug_empty') + '</div>'));
            this.activity.toggle();
        };

        // start() викликається щоразу, коли екран отримує фокус —
        // і при створенні, і при поверненні з екрана, відкритого поверх.
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
                back: function () { Lampa.Activity.backward(); }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop  = function () {};   // поверх відкрили інший екран — НЕ чистимо

        // destroy() — критично. Тут звільняємо все.
        this.destroy = function () {
            inited = false;
            network.clear();
            items.forEach(function (card) { if (card.destroy) card.destroy(); });
            items = [];
            scroll.destroy();
            grid.remove();
        };

        this.render = function (js) {
            return js ? scroll.render(true) : scroll.render();
        };
    }


    // =====================================================================
    //  6. ПУНКТ БОКОВОГО МЕНЮ
    // =====================================================================
    function addMenuItem() {
        var item = $('<li class="menu__item selector">'
            + '<div class="menu__ico">'
            + '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
            + '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" '
            + 'fill="none" stroke="currentColor" stroke-width="2" '
            + 'stroke-linecap="round" stroke-linejoin="round"/></svg>'
            + '</div>'
            + '<div class="menu__text">' + Lampa.Lang.translate('myplug_menu') + '</div>'
            + '</li>');

        item.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: Lampa.Lang.translate('myplug_title'),
                component: ID,
                page: 1
            });
        });

        $('.menu .menu__list').eq(0).append(item);
    }


    // =====================================================================
    //  7. КНОПКА НА КАРТЦІ ФІЛЬМУ
    //  Вставляється по події full:complite.
    // =====================================================================
    function addCardButton() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;
            if (!enabled()) return;

            var render = e.object.activity.render();

            // не дублюємо, якщо подія прийшла двічі
            if (render.find('.view--myplug').length) return;

            var btn = $('<div class="full-start__button selector view--myplug">'
                + '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'
                + '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" '
                + 'fill="none" stroke="currentColor" stroke-width="2" '
                + 'stroke-linecap="round" stroke-linejoin="round"/></svg>'
                + '<span>' + Lampa.Lang.translate('myplug_card_button') + '</span>'
                + '</div>');

            btn.on('hover:enter', function () {
                Lampa.Noty.show(e.data.movie.title || e.data.movie.name);
                console.log(LOG, 'card:', e.data.movie);
            });

            // .view--torrent може бути відсутнім (торенти вимкнено) —
            // тому є запасний контейнер.
            var anchor = render.find('.view--torrent');

            if (anchor.length) anchor.after(btn);
            else render.find('.full-start-new__buttons, .full-start__buttons')
                       .eq(0).append(btn);
        });
    }


    // =====================================================================
    //  8. ІНІЦІАЛІЗАЦІЯ
    // =====================================================================
    function init() {
        console.log(LOG, 'init, Lampa', Lampa.Manifest.app_version);

        registerLang();
        registerStyles();
        registerManifest();
        registerSettings();

        Lampa.Component.add(ID, Screen);

        if (enabled()) addMenuItem();

        addCardButton();

        console.log(LOG, 'ready');
    }

    // ── ЗАХИСТ 2: appready ──────────────────────────────────────────────
    // window.Lampa існує одразу, але Menu / Activity / Settings / Player
    // ще НЕ ініціалізовані. Нічого не робимо на верхньому рівні.
    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') init();
    });
})();
