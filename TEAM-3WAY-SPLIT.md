# StockMind: разделение работ на три коммита

## Важное про EXE

`StockMind-Setup-x64.exe` и `StockMind-Portable-x64.exe` — готовые контейнеры установщика/приложения, а не исходный код. Их нельзя осмысленно поделить на «ядро» и «микросервисы»: коммиты делают по исходникам, после интеграции собирают один итоговый EXE. Папка `electron/providers/` содержит **адаптеры-провайдеры в основном процессе Electron**, а не отдельные сетевые микросервисы с независимым deployment. Для desktop-приложения это снижает сложность; при необходимости сервисного развертывания потребуется отдельная архитектурная задача.

## Участник 1 — доменное ядро и локальный учёт

**Владелец:** расчёты и SQLite persistence; не трогать HTML/renderer и внешние API.

Файлы:

- `src/local-core.js`
- `src/analytics-core.js`
- `src/alerts-core.js`
- `src/fx-core.js`
- `electron/sqlite-store.cjs`
- `tests/local-core.test.cjs`
- `tests/analytics-core.test.cjs`
- `tests/alerts-core.test.cjs`
- `tests/fx-core.test.cjs`
- `tests/sqlite-store.test.cjs`

Проверка: `node --test tests/local-core.test.cjs tests/analytics-core.test.cjs tests/alerts-core.test.cjs tests/fx-core.test.cjs tests/sqlite-store.test.cjs`.

Предлагаемый коммит: `feat(core): strengthen portfolio, analytics and SQLite domain layer`.

## Участник 2 — источники данных и защищённые секреты

**Владелец:** нормализация внешних данных/ошибок/лимитов; не менять renderer, SQLite schema и API маршрутизацию в `main.cjs`.

Файлы:

- `electron/providers/moex-iss.cjs`
- `electron/providers/alpha-vantage.cjs`
- `electron/providers/news-gdelt.cjs`
- `electron/providers/cbr-fx.cjs`
- `electron/secure-secrets.cjs`
- `tests/moex-provider.test.cjs`
- `tests/alpha-vantage-provider.test.cjs`
- `tests/alpha-vantage.test.cjs`
- `tests/news-provider.test.cjs`
- `tests/cbr-fx.test.cjs`
- `tests/secure-secrets.test.cjs`

Проверка: `node --test tests/moex-provider.test.cjs tests/alpha-vantage-provider.test.cjs tests/alpha-vantage.test.cjs tests/news-provider.test.cjs tests/cbr-fx.test.cjs tests/secure-secrets.test.cjs`.

Контракт провайдера: адаптер экспортирует фабрику `create...Provider()` и асинхронный метод (`fetchCandles`, `fetchLatest` либо `fetchRates`); возвращает нормализованные данные или короткую понятную ошибку без секрета. Новый endpoint/параметр требует согласования интегратора.

Предлагаемый коммит: `feat(providers): harden market, news and FX adapters`.

## Участник 3 — Electron-оболочка, UI и интеграция

**Владелец:** окно, IPC, loopback gateway, фоновые задачи и пользовательские потоки. Единственный, кто меняет маршрутизацию `main.cjs` или bridge `preload.cjs`.

Файлы:

- `electron/main.cjs`
- `electron/preload.cjs`
- `src/index.html`
- `src/style.css`
- `src/app.js`
- `src/workspace.js`
- `package.json`
- `package-lock.json`
- smoke/integration тесты, отчёты релиза и документация запуска

Проверка: `npm test`; `node --check electron/main.cjs electron/preload.cjs src/app.js src/workspace.js`; затем двухзапусковый Electron smoke с отдельной тестовой папкой LOCALAPPDATA.

Предлагаемый коммит: `feat(desktop): integrate providers, secure IPC and refreshed UI`.

## Порядок работы и правила слияния

1. Сначала согласовать JSON/публичные функции ядра и SQLite migration с участником 3.
2. Участник 1 и 2 работают параллельно по своим непересекающимся каталогам; интегратор не редактирует их файлы в тех же ветках.
3. Слить изменения 1 (ядро), затем 2 (адаптеры), затем 3 (интеграция и UI). Если потребуется правка общего контракта, владелец контракта выпускает отдельный небольшой коммит, а остальные делают rebase.
4. Все ветки от одного общего baseline; не добавлять EXE в git-коммиты. Большие релизные бинарники выпускаются один раз после сборки; к ним фиксируются SHA-256.
5. До коммита: `npm ci`, `npm test`, syntax checks. Перед финальной сборкой — два последовательных runtime smoke и проверка `sha256sum -c release/SHA256SUMS.txt`.

## Git-состояние на момент подготовки

В восстановленной папке `/home/ubuntu/stockmind` **нет каталога `.git` и нет истории коммитов**. Поэтому эта карта задаёт точные границы коммитов, но не создаёт фиктивные коммиты от имени трёх людей. Для реальной совместной работы сначала клонируйте/инициализируйте общий репозиторий, затем назначьте владельцев и авторов.
