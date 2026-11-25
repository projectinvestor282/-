Участник 3 — Desktop/UI интеграция

Коммит: feat(desktop): integrate providers, secure IPC and refreshed UI

Содержимое: Electron main/preload, loopback API и IPC, интерфейс, package metadata, карта разделения и аудит. Интегратор владеет маршрутами main.cjs/preload.cjs и собирает изменения двух остальных участников.

Проверка из корня общего репозитория: npm ci && npm test; затем Electron runtime smoke. Windows EXE из этого ZIP не собирается автоматически.
