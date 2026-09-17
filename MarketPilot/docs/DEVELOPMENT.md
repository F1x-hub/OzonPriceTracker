# MarketPilot: проверка и сборка

Расширение запускается как распакованная MV3-папка с manifest.json.

    cd D:\Programing\JS\Projects\MarketPilot\MarketPilot
    npm test
    npm run build

npm test проверяет manifest, ссылки на ресурсы, syntax всех runtime-скриптов, отсутствие inline scripts и transition: all, registry/экспортные строки и background VM-контракт. npm run build повторяет проверки и создаёт готовую папку dist/; она генерируется скриптом и не редактируется вручную.

Брендовый знак хранится в `assets/marketpilot-mark.svg` и соответствует Figma-варианту `One Color`. PNG-копии из того же знака (`16`, `32`, `48` и `128`) используются иконками manifest и уведомлений; после изменения asset пересоберите расширение.

Для ручного запуска откройте chrome://extensions, включите Developer mode и нажмите Load unpacked. Выберите MarketPilot/dist после сборки или MarketPilot для быстрой проверки исходников. После изменения content script нажмите Reload у расширения и обновите открытую страницу магазина.

Минимальный live-чеклист выполняется после статических проверок:

- popup на Ozon: чтение карточки, добавление и изменение отслеживания;
- compact popup на неподдерживаемой странице и карточках WB/Citilink: контекст площадки, registry-driven действия и переход в нужный модуль дашборда;
- dashboard: маршруты «Обзор», «Магазины» (вкладки Ozon/Wildberries/Citilink), «Задания», «История», «AI и настройки», фильтры, ссылка на карточку Ozon, интервалы, ручная проверка, просмотр результатов, единая история действий/заданий/уведомлений, lazy XLSX и настройки DeepSeek с моделями V4.1 Flash/V4 Pro, thinking mode, балансом, локальной статистикой расходов MarketPilot как основной и официальным usage аккаунта для сравнения, а также графиком локальных расходов по дням за последние 30 дней; дневные агрегаты хранятся локально за 180 дней;
- WB/Citilink: DOM-сбор, частичные результаты, очистка и экспорт;
- Seller: переходы reviews/questions/Rich, lifecycle cleanup, генерация и согласованный тест отправки;
- restart service worker/Chrome и восстановление stale job.

Для нового магазина добавьте запись в core/marketplaces.js, capability и DOM/content entrypoint только для реально поддержанной операции. Общие очереди, background commands, dashboard routes и storage keys менять не нужно для адаптера существующей capability; новые операции получают отдельный feature-контракт.

Dashboard использует marketplace registry для вкладок и карточек обзора. Старые hash-адреса `#/products`, `#/monitoring`, `#/collection`, `#/replies` и `#/content` поддерживаются как совместимые перенаправления в `#/stores` с нужным магазином и модулем.
