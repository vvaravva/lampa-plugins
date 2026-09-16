# Мої плагіни для Lampa

Стартовий проєкт для розробки плагінів під Lampa (Android TV застосунок `lampa-app/LAMPA`,
десктоп `lampaua-desktop`, будь-яка веб-збірка).

```
lampa-plugins/
  rd.js                ← РОБОЧИЙ ПЛАГІН: відтворення релізів через Real-Debrid
  omi.js               ← РОБОЧИЙ ПЛАГІН: розширені теги відео на картках «Онлайн»
  src/
    my-plugin.js       ← повний скелет: налаштування, свій екран, меню, кнопка на картці
    tweak-example.js   ← мінімальний твік: одна подія + правка DOM
  docs/
    ru/  en/           ← офіційна документація з сирців Lampa (13 розділів)
  package.json
```

Готові до встановлення плагіни лежать у **корені** репозиторію — так URL коротший
і його реально набрати з пульта. У `src/` тільки заготовки для розробки.

---

## Real-Debrid

Кнопка **Real-Debrid** на картці фільму. Відкриває свій екран зі списком релізів,
після вибору — віддає роздачу в Real-Debrid і грає готове пряме посилання,
без TorrServer і без завантаження на пристрій.

**URL для встановлення:**

```
https://vvaravva.github.io/lampa-plugins/rd.js
```

Далі: **Налаштування → Real-Debrid → API-токен** (взяти на `real-debrid.com/apitoken`).

### Як працює

```
Кнопка на картці
  → Lampa.Parser.get()          свій, уже налаштований парсер
  → список релізів
  → POST /torrents/addMagnet
  → GET  /torrents/info/{id}    чекаємо список файлів
  → POST /torrents/selectFiles  найбільший відеофайл
  → GET  /torrents/info/{id}    опитуємо до status: downloaded
  → POST /unrestrict/link       пряме https-посилання
  → Lampa.Player.play()
```

Список релізів бере **`Lampa.Parser.get`** — публічний метод Lampa, який сам
розрулює Jackett / Prowlarr / TorrServer. Тобто плагін використовує той самий
парсер, що вже налаштований у Налаштуваннях, і нічого не дублює.

### Тільки Android

`api.real-debrid.com` не віддає `Access-Control-Allow-Origin`, тому звичайний
XHR зі сторінки блокується CORS. Плагін ходить через `Lampa.Reguest.native()`,
а Lampa маршрутизує його так:

```js
function native(params){
    if(Platform.is('android')) android_go(params)   // AndroidJS.httpReq
    else go(params)                                  // звичайний XHR
}
```

Нативний міст Android-застосунку CORS не обмежує. Наслідок: **працює в
Android-застосунку LAMPA**, не працює в браузері, на webOS і Tizen. Це межа
платформи, не баг.

### Поведінка й межі

- **Немає в кеші RD** — екран показує відсотки завантаження на боці RD,
  «Назад» скасовує й повертає до списку. Плагін нічого не вирішує за тебе
  і не підставляє тихцем інший реліз.
- **Тільки фільми.** Серіали потребують зіставлення сезону/серії з файлами
  всередині роздачі та плейлиста — це окрема робота.
- **Потрібен magnet.** Релізи, де парсер дав лише посилання на `.torrent`,
  позначені `без magnet` і не запускаються: заливка бінарника в RD — окремий
  ендпоінт, помітно складніший з JS.
- Токен зберігається в `Lampa.Storage` у відкритому вигляді — як і всі інші
  ключі в Lampa.

---

## Online MediaInfo

**URL для встановлення:**

```
https://vvaravva.github.io/lampa-plugins/omi.js
```

Налаштування → Розширення → Додати плагін.

Додає на картки розділу «Онлайн» теги, яких немає в стандартному рядку балансера:
тип ріпу (**BDRemux / WEB-DL / BDRip**), **Dolby Vision**, **HDR10+**, кодек
(**x265 / AV1**), глибина (**10bit**), аудіо (**Atmos / DTS-HD MA / TrueHD**),
канали (**7.1 / 5.1**) та мітки релізу (**IMAX, Extended, Proper, REPACK**).

### Як воно чіпляється

Онлайн-плагін Lampac малює картку через
`Lampa.Template.get('lampac_prestige_full', element)`, де `element` — сирий
об'єкт від балансера. Плагін **обгортає `Lampa.Template.get`** і таким чином
отримує і готову jQuery-картку, і всі поля `element`.

Чому саме так: свої події Lampac не шле взагалі, а MutationObserver по DOM
ламався б від будь-якої зміни верстки. Хук на `Template.get` залежить лише від
імені шаблону.

### Звідки беруться дані

Рядок «2160p / 6.89 GB / SDR / ↑21» і бейдж «4K» приходять **із сервера**
(у `online.js` рядків `HDR`/`SDR` немає) — клієнт просто друкує те, що дав
балансер. Тип ріпу, кодек і аудіо там відсутні, тому плагін бере їх із **назви
релізу**.

Назва може лежати в різних полях залежно від балансера (`title`, `text`,
`details`, `name`…), тому плагін склеює **всі рядкові поля** `element` і шукає
токени по них. URL та службові ключі відкидаються. Хибне спрацювання майже
виключене — матчаться тільки відомі технічні позначки.

Дублі не показуються: якщо балансер уже написав «2160p» і «SDR», ці теги
відкидаються.

### Якщо теги не з'явились

Увімкни **Налаштування → Online MediaInfo → Режим діагностики**. На картці
з'явиться список полів, які реально прислав балансер, і склеєний текст. Видно
прямо на телевізорі — DevTools не потрібні.

Якщо там немає назви релізу — значить балансер її не віддає, і парсити нічого.
Тоді єдиний шлях — ffprobe з TorrServer.

---

## Швидкий старт

### 1. Запустити локальний сервер

```bash
npm run dev
```

Плагін доступний за `http://localhost:8080/my-plugin.js`.

### 2. Відкрити Lampa в Chrome на ПК

Ту саму збірку, яку вантажить твій телевізор (наприклад `http://lampa.mx`).

### 3. Заінжектити плагін через DevTools Console

Найшвидший цикл ітерації — не треба нічого додавати в налаштування:

```js
(function(){let s=document.createElement('script');s.src='http://localhost:8080/my-plugin.js?'+Date.now();document.head.appendChild(s)})()
```

`?Date.now()` збиває кеш — після кожної правки просто виконуй знову з перезавантаженням сторінки.

### 4. Перевірити синтаксис перед комітом

```bash
npm run check
```

---

## Публікація

1. Створити репозиторій на GitHub, залити цей проєкт.
2. Settings → Pages → Deploy from branch → `main` / `root`.
3. URL плагіна: `https://<нік>.github.io/lampa-plugins/src/my-plugin.js`
4. На телевізорі: **Налаштування → Розширення → Додати плагін** → вставити URL.

---

## Що варто знати про завантаження плагінів

Із `src/core/plugins.js` сирців Lampa:

- Список встановлених плагінів лежить у `localStorage.plugins` як `[{url, status}]`.
- До URL автоматично додаються `email`, `logged`, `origin`, `reset=<random>` —
  тобто **кеш браузера завжди збивається**, оновлення підхоплюється одразу.
- Плейсхолдери `{storage_КЛЮЧ}` в URL розкриваються у base64-значення з localStorage.
- Якщо Lampa відкрита по **https**, http-URL плагіна буде переписано на https.
  Тому `http://192.168.x.x:8080` з https-збірки **не підтягнеться** — для локальної
  розробки використовуй http-збірку Lampa або інжект через консоль (спосіб вище).
- Є чорний список хостів: `t.me/`, `tinyurl.com`, `4pda.`, `teletype.in` та інші.
  Скорочувачі посилань не працюють — потрібен прямий URL.
- Код успішно завантаженого плагіна кешується в IndexedDB і використовується
  як запасний варіант, якщо сервер недоступний.

---

## Чому не розробляти одразу на телевізорі

У релізному APK `LAMPA` стоїть `setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` —
тобто `chrome://inspect` для рушія **SysView не працює**.

Виняток: якщо в налаштуваннях застосунку перемкнути рушій на **XWalk** (Crosswalk),
там `REMOTE_DEBUGGING` увімкнено безумовно і віддалена відладка доступна.
Але це Chromium ~53 — багато сучасного JS відпаде.

Робочий цикл: **пиши й дебаж у Chrome на ПК → фінальна перевірка на телевізорі**
(фокус пультом, швидкодія).

---

## Карта API

| Об'єкт | Призначення |
|---|---|
| `Lampa.Listener` | Глобальна шина подій: `app`, `activity`, `full`, `line`, `menu`, `torrent`, `torrent_file`, `request_*`, `resize_*` |
| `Lampa.Storage` | `.get(key, default)` / `.set(key, value)` / `.field(key)` — значення з урахуванням default із налаштувань |
| `Lampa.SettingsApi` | `.addComponent()` / `.addParam()` — типи `trigger`, `select`, `input` |
| `Lampa.Component` | `.add(name, Constructor)` — реєстрація свого екрана |
| `Lampa.Activity` | `.push({component, ...})` / `.backward()` / `.active()` |
| `Lampa.Controller` | Фокус на TV: `.add(name, handlers)`, `.toggle(name)`, `.collectionSet()`, `.collectionFocus()` |
| `Navigator` | Просторова навігація: `.canmove(dir)`, `.move(dir)` (глобал, не всередині `Lampa`) |
| `Lampa.Template` | `.add(name, html)` / `.get(name, data, js)` |
| `Lampa.Lang` | `.add({key:{uk,ru,en}})` / `.translate(key)`; у HTML — плейсхолдер `#{key}` |
| `Lampa.Reguest` | HTTP: `new Lampa.Reguest()`, `.silent(url, ok, err)`, `.clear()` |
| `Lampa.Scroll` | `new Lampa.Scroll({mask:true, over:true})`, `.append()`, `.update()`, `.render(js)` |
| `Lampa.Card` | `new Lampa.Card(data, params)`, `.create()`, `.visible()`, `.onFocus`, `.onEnter` |
| `Lampa.Noty` / `Lampa.Select` / `Lampa.Modal` | Спливні сповіщення / bottom-sheet / модалка |
| `Lampa.Player` | `.listener.follow('create'\|'start'\|...)`; у `create` є `data.abort()` |
| `Lampa.Manifest` | `.app_version`, `.app_digital`, `.plugins = {...}` |
| `Lampa.Subscribe` | Створити власну приватну шину подій |

Нативний міст (тільки в Android-застосунку, `window.AndroidJS`):
`openPlayer`, `openTorrentLink`, `openYoutube`, `openBrowser`, `updateChannel`,
`saveBookmarks`, `httpReq`, `voiceStart`, `setProxyPAC`, `appVersion`, `exit`.

---

## Обов'язкові правила

1. **Захист від подвійного завантаження** — глобальний прапорець на початку файлу.
2. **Захист `appready`** — нічого не робити на верхньому рівні IIFE.
   `window.Lampa` вже є, але Menu / Activity / Settings / Player ще не готові.
3. **Префіксувати ключі Storage** назвою плагіна — інакше колізії з іншими плагінами.
4. **Знімати слухачі в `destroy()`** — зберігай хендлер в іменовану змінну,
   анонімну функцію не можна видалити.
5. **Прапорець `inited`** — асинхронна відповідь може прийти після `destroy()`.
6. **Тільки jQuery-події** (`hover:enter`, `hover:focus`, `hover:long`),
   не нативні DOM-події — інакше не працюватиме пульт.
7. **Не перезаписувати `window.lampa_settings`**.

Повний список — `docs/ru/11-pitfalls.md`.

---

## Документація

`docs/ru/` — копія офіційної документації з репозиторію
[yumata/lampa-source](https://github.com/yumata/lampa-source) (автор Yumata,
GPL-2.0), покладена тут для офлайн-доступу. Деталі — [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

| Файл | Про що |
|---|---|
| `01-getting-started.md` | Що таке плагін, структура, патерни захисту |
| `02-lifecycle.md` | Життєвий цикл, контракт компонента, `this.activity` |
| `03-events.md` | Шина подій, події плеєра, власна шина |
| `04-storage-network.md` | Storage API, HTTP-запити |
| `05-templates-lang.md` | Шаблони, i18n, впровадження CSS |
| `06-ui-components.md` | Noty, Select, Modal, керування фокусом |
| `07-navigation.md` | Стек Activity, реєстрація компонентів, Router |
| `08-settings.md` | Розділи й параметри налаштувань |
| `09-manifest-menu.md` | Контекстне меню картки, пункт бокового меню |
| `10-player.md` | Інтеграція з плеєром, доріжки |
| `11-pitfalls.md` | Типові помилки |
| `12-debug.md` | Логування, дебаг, дев-збірка |
| `13-controller.md` | Controller, TV-навігація, коди кнопок пульта |

---

## Корисні посилання

- Сирці Lampa: https://github.com/yumata/lampa-source
- Android-застосунок: https://github.com/lampa-app/LAMPA
- Десктоп LampaUa: https://github.com/Hlushok/lampaua-desktop
- Приклади живих плагінів: https://github.com/levende/lampa-plugins
- Технічна вікі: https://deepwiki.com/yumata/lampa-source
