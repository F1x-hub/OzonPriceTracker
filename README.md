# MarketPilot

<div align="center">
  <img src="MarketPilot/assets/marketpilot-mark.svg" width="96" alt="Логотип MarketPilot">
  <p>Chrome-расширение Manifest V3 для мониторинга цен, сбора данных о товарах и автоматизации задач продавца.</p>

  <p>
    <img src="https://img.shields.io/badge/MANIFEST-V3-168bd3?logo=googlechrome&logoColor=white&labelColor=434950" alt="Manifest V3">
    <a href="https://github.com/F1x-hub/MarketPilot/releases/tag/v1.0.8"><img src="https://img.shields.io/badge/VERSION-1.0.8-65b32e?labelColor=434950" alt="Latest release v1.0.8"></a>
    <img src="https://img.shields.io/badge/JAVASCRIPT-ES6%2B-f0db4f?logo=javascript&logoColor=111827&labelColor=434950" alt="JavaScript ES6 plus">
    <img src="https://img.shields.io/badge/VANILLA-ES6%2B-f0db4f?labelColor=434950" alt="Vanilla JavaScript ES6 plus">
    <img src="https://img.shields.io/badge/MAINTAINER-F1x--hub-f97316?labelColor=434950" alt="Maintainer F1x-hub">
    <img src="https://img.shields.io/badge/LICENSE-UNDECLARED-aeb4bd?labelColor=434950" alt="License undeclared">
  </p>
</div>

## О проекте

MarketPilot объединяет мониторинг карточек Ozon, сбор цен Wildberries, подготовку карточек Citilink и инструменты Ozon Seller в одном локальном расширении. Popup отвечает за быстрые действия на текущей странице, а dashboard — за товары, задания, результаты, историю и настройки.

Все пользовательские данные хранятся локально через `chrome.storage.local`. Встроенный AI-помощник работает через DeepSeek API и использует ключ и баланс аккаунта пользователя.

## Возможности

| Направление | Что доступно |
| --- | --- |
| Ozon | Добавление карточек по ссылке, целевая цена, учёт цены с Ozon Банком или без него, фоновые проверки и уведомления. |
| Ozon Seller | Массовые ответы на отзывы, AI-ответы на вопросы покупателей и массовое заполнение Rich-контента. Требуется авторизация в кабинете продавца. |
| Wildberries | Сбор цен по артикулам, параллельная обработка, частичные результаты, очистка и экспорт в XLSX. |
| Citilink | Сбор данных карточек по кодам, генерация описаний через DeepSeek, подготовка материалов для Avito и экспорт в XLSX. |
| Dashboard | Обзор, магазины, задания, история действий, фильтры, тёмная тема и настройки производительности. |
| DeepSeek | API-ключ, системные промпты, модели `deepseek-flash` и `deepseek-v4-pro`, thinking mode, reasoning effort, баланс и локальная статистика токенов и расходов. |

## Быстрый старт

### Установка расширения

1. Скачайте или клонируйте репозиторий.
2. Откройте `chrome://extensions` в Chrome или совместимом Chromium-браузере.
3. Включите **Developer mode**.
4. Нажмите **Load unpacked** и выберите папку `MarketPilot/`, в которой находится `manifest.json`.
5. После изменения исходников нажмите **Reload** у расширения и обновите открытые страницы магазинов.

Для установки готовой сборки сначала выполните `npm run build`, затем выберите `MarketPilot/dist/`. Папка `dist/` генерируется автоматически и не редактируется вручную.

### Первичная настройка

- Для мониторинга Ozon откройте карточку товара или добавьте ссылку через dashboard.
- Для функций Ozon Seller войдите в `seller.ozon.ru`.
- Для AI откройте **Dashboard → AI и настройки**, сохраните собственный ключ DeepSeek и выберите модель.
- Для WB и Citilink откройте **Dashboard → Магазины**, укажите артикулы или коды товаров и запустите задание.

## Разработка и проверки

Требуется Node.js с npm. Установка сторонних npm-зависимостей не нужна: runtime расширения использует встроенный JavaScript и включённую копию SheetJS для XLSX.

```bash
cd MarketPilot
npm test
npm run build
```

`npm test` проверяет:

- Manifest V3 и наличие всех заявленных ресурсов;
- синтаксис runtime-скриптов;
- отсутствие inline-скриптов и запрещённых `transition: all`;
- контракты marketplace registry и XLSX-экспорта;
- VM smoke-тест background service worker, миграций, настроек, очередей и DeepSeek-статистики.

`npm run build` повторяет проверки и создаёт готовую распакованную сборку в `MarketPilot/dist/`.

После статических проверок нужен ручной live-чек в Chrome:

- popup и виджет на реальной карточке Ozon;
- карточки WB и Citilink, включая частичные результаты и экспорт XLSX;
- отзывы, вопросы и Rich-контент в Ozon Seller;
- перезапуск service worker и восстановление незавершённого задания;
- обновление расширения после изменения content script.

Статические проверки не доказывают доступность конкретной страницы магазина, корректность её текущих DOM-селекторов, работу сессии Seller или успешную отправку ответа.

## Архитектура

```text
Popup / Dashboard
        │
        ├── chrome.runtime.sendMessage
        │
Background service worker
        ├── chrome.storage.local  — данные, настройки, история и статистика
        ├── chrome.alarms         — плановые проверки цен
        ├── chrome.notifications   — уведомления о событиях
        ├── Ozon / WB / Citilink   — фоновые операции и очереди
        └── DeepSeek API           — генерация и баланс
        │
Content scripts на страницах маркетплейсов
```

Marketplace registry в `core/marketplaces.js` задаёт поддерживаемые магазины, capabilities, dashboard-модули и действия popup. Это позволяет добавлять адаптеры без дублирования общих маршрутов, очередей и storage-контрактов.

## Структура проекта

```text
.
├── README.md
└── MarketPilot/
    ├── manifest.json           # Manifest V3, permissions и content scripts
    ├── background.js           # Service worker, очереди, уведомления и DeepSeek API
    ├── popup.html / popup.js   # Полный popup расширения
    ├── popup_compact.*         # Компактное окно быстрых действий
    ├── dashboard.*             # Основной dashboard
    ├── content.js              # Интеграция карточек Wildberries
    ├── ozon_content.js         # Shadow DOM-виджет карточки Ozon
    ├── citilink_content.js     # Сбор данных Citilink
    ├── seller_content.js       # Seller: отзывы, вопросы и Rich-контент
    ├── seller_dom.js           # Общие DOM-хелперы Seller
    ├── seller_lifecycle.js     # Управление жизненным циклом Seller UI
    ├── core/                   # Storage, marketplace registry и тема
    ├── features/               # Переиспользуемые функциональные модули
    ├── assets/                 # Логотип и иконки расширения
    ├── scripts/                # Проверка, smoke-тест и сборка
    └── docs/                   # Development, audits и рабочие материалы
```

## Permissions и данные

| Разрешение | Назначение |
| --- | --- |
| `storage` | Локальные товары, настройки, история, статусы заданий и DeepSeek-статистика. |
| `alarms` | Периодические проверки отслеживаемых товаров Ozon. |
| `notifications` | Локальные уведомления о снижении цены и завершении операций. |
| `tabs` | Работа с карточками магазинов и служебными вкладками сбора данных. |
| `scripting` | Выполнение поддерживаемых операций в контексте вкладки магазина. |
| Host permissions Ozon/WB/Citilink/Seller | Доступ к страницам и DOM только поддерживаемых площадок. |
| `api.deepseek.com`, `platform.deepseek.com` | Генерация ответов, проверка баланса и чтение официальной usage-статистики при открытой сессии пользователя. |

API-ключ DeepSeek не должен попадать в Git, screenshots или issue. Он вводится пользователем в dashboard и сохраняется в локальном хранилище Chrome. Запросы к DeepSeek выполняются от имени аккаунта пользователя и расходуют его баланс.

## Ограничения

- Селекторы и сетевые ответы маркетплейсов могут измениться без предупреждения.
- Для Ozon Seller необходима активная авторизация и доступ к нужному разделу кабинета.
- Live-проверки требуют реального браузера, открытых страниц и актуальной сессии; `npm test` их не заменяет.
- В репозитории пока нет файла `LICENSE`, поэтому юридическая лицензия проекта не заявлена.

## Релиз и документация

Целевой релиз — [**v1.0.8**](https://github.com/F1x-hub/MarketPilot/releases/tag/v1.0.8). Версия расширения в `MarketPilot/manifest.json` и `MarketPilot/package.json` синхронизирована с этим релизом.

Дополнительные инструкции по разработке находятся в [`MarketPilot/docs/DEVELOPMENT.md`](MarketPilot/docs/DEVELOPMENT.md), а результаты аудитов и рабочие планы — в [`MarketPilot/docs/`](MarketPilot/docs/).

## Авторство

Проект опубликован в репозитории [F1x-hub/MarketPilot](https://github.com/F1x-hub/MarketPilot). Текущий бренд расширения — **MarketPilot**.
