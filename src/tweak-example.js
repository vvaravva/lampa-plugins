(function () {
    'use strict';

    // =====================================================================
    //  Мінімальний плагін-твік
    //  Типовий випадок: підписатись на подію і трохи змінити інтерфейс.
    //  Саме з такого варто починати — тут немає ні свого екрана,
    //  ні Controller, ні мережі.
    //
    //  Що робить: на сторінці картки фарбує статус серіалу
    //  ("Триває", "Завершено") у різні кольори.
    // =====================================================================

    var LOG = '[tweak]';

    if (window.plugin_tweak_ready) return;
    window.plugin_tweak_ready = true;

    var COLORS = {
        tv_status_returning_series: '#FFA000',
        tv_status_in_production:    '#42A5F5',
        tv_status_planned:          '#42A5F5',
        tv_status_post_production:  '#42A5F5',
        tv_status_pilot:            '#FFA000',
        tv_status_rumored:          '#607D8B',
        tv_status_canceled:         '#FF5722',
        tv_status_released:         '#38A564',
        tv_status_ended:            '#38A564'
    };

    function colorOf(text) {
        for (var key in COLORS) {
            if (Lampa.Lang.translate(key) === text) return COLORS[key];
        }
        return '';
    }

    function init() {
        console.log(LOG, 'init');

        Lampa.Listener.follow('full', function (e) {
            if (e.type !== 'complite') return;

            // DOM картки будується не миттєво — даємо кадр на відмальовку
            setTimeout(function () {
                var render = e.object.activity.render();

                render.find('.full-start__status').each(function () {
                    var el    = $(this);
                    var color = colorOf(el.text().trim());

                    if (color) el.css('background-color', color);
                });
            }, 100);
        });
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') init();
    });
})();
