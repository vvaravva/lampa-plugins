(function () {
    'use strict';

    // =====================================================================
    //  Compatibility loader for the old install URL.
    //
    //  The plugin moved to the repository root as omi.js, so the URL is
    //  short enough to type on a TV remote. Installs still pointing at this
    //  old path keep working through this loader instead of silently 404ing.
    //
    //  Having both URLs installed at once is harmless: the plugin carries
    //  its own double-load guard.
    // =====================================================================

    if (window.plugin_omi_ready) return;

    var s = document.createElement('script');

    s.src = 'https://vvaravva.github.io/lampa-plugins/omi.js?' + Date.now();

    document.head.appendChild(s);
})();
