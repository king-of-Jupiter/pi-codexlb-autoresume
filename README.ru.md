# pi-codexlb-autoresume

[English](./README.md) | **Русский**

Расширение для [pi](https://github.com/badlogic/pi-mono) / [oh-my-pi](https://github.com/can1357/oh-my-pi):
автопауза и автопродолжение агента по лимитам [codex-lb](https://github.com/Soju06/codex-lb).

Плагин опрашивает usage-эндпоинт балансировщика (`limits[]`, окна `5h`/`7d`) и
впрыскивает сообщения в ту же сессию:

- остаток упал ниже линии паузы → агенту уходит pause-сообщение **steer**
  (прерывает текущий ход): сохрани результат и жди;
- лимиты восстановились выше линии продолжения → уходит resume-сообщение,
  агент продолжает с места остановки.

Никакого виджета и команды `/limits` здесь нет — за отображение отвечает
компаньон [pi-codexlb-usage](https://github.com/king-of-Jupiter/pi-codexlb-usage) (оба ставятся рядом без
конфликтов). Этот плагин владеет только командой `/autoresume`.

Работает и внутри [Paseo](https://paseo.sh): провайдер `omp` запускает
`omp --mode rpc` с включёнными расширениями, очередь extension-сообщений
поддерживается. Условия: расширение установлено в daemon-scope
(`~/.omp/agent/extensions/` пользователя daemon), а `CODEXLB_URL`/`CODEXLB_TOKEN`
видны процессу daemon.

## Установка

**oh-my-pi**

```sh
omp install git:github.com/king-of-Jupiter/pi-codexlb-autoresume
```

Альтернатива — вручную:

```sh
git clone https://github.com/king-of-Jupiter/pi-codexlb-autoresume.git
omp plugin link ./pi-codexlb-autoresume
```

Вариант через npm (нужен `bun` в PATH):

```sh
omp install npm:pi-codexlb-autoresume
```

**pi**

```sh
git clone https://github.com/king-of-Jupiter/pi-codexlb-autoresume.git
```

Или скопируйте `index.ts` + `src/` + `hooks/` в
`~/.pi/agent/extensions/pi-codexlb-autoresume/` (pi) или
`~/.omp/agent/extensions/pi-codexlb-autoresume/` (omp).

Зависимостей нет. Нужен Node 22+ (хост выполняет TypeScript напрямую).

## Настройка

Минимум — endpoint и токен (общие с pi-codexlb-usage; читаются из его файла,
если он настроен):

```sh
export CODEXLB_URL="https://example.com/api/usage"
export CODEXLB_TOKEN="<bearer-token>"
```

или внутри сессии:

```
/autoresume set-url https://example.com/api/usage
/autoresume set-token <token>
```

Пороги — это **остаток** в процентах. Дефолт: пауза при остатке `< 10%`,
продолжить при остатке `> 30%` (гистерезис обязателен: resume всегда выше pause).

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `CODEXLB_URL` (`CODEXLB_USAGE_URL`) | Usage-эндпоинт | — |
| `CODEXLB_TOKEN` (`CODEXLB_BEARER_TOKEN`) | Bearer-токен | — |
| `CODEXLB_LABEL` | Подпись источника | `CodexLB` |
| `AUTORESSUME_ENABLED` | `1`/`0` — мастер-выключатель | `1` |
| `AUTORESSUME_PAUSE_PCT` | Линия паузы (остаток %) | `10` |
| `AUTORESSUME_RESUME_PCT` | Линия продолжения (остаток %) | `30` |
| `AUTORESSUME_POLL_MS` | Интервал опроса (минимум 15000) | `60000` |
| `AUTORESSUME_WATCH` | `any` — худшее из окон; либо `5h`, `7d` | `any` |
| `AUTORESSUME_PAUSE_MSG` | Текст паузы | RU-дефолт (см. ниже) |
| `AUTORESSUME_RESUME_MSG` | Текст продолжения | RU-дефолт |
| `AUTORESSUME_RETRY_ON_ERROR` | Мгновенный retry-on-error | `0` (выкл) |
| `AUTORESSUME_RETRY_COOLDOWN_SEC` | Пауза между авто-продолжениями | `120` |
| `AUTORESSUME_RETRY_MAX` | Бюджет на 30-мин окно | `3` |
| `AUTORESSUME_CONFIG` | Путь к своему config.json | `~/.config/pi-codexlb-autoresume/config.json` |
| `AUTORESSUME_DEBUG` | Отладочные логи в stderr (без токена) | выкл |

Env побеждает по́льно. Без env читается свой файл, для endpoint/token —
дополнительно общий файл pi-codexlb-usage. Свой файл создаётся с mode 0600.

Дефолтные тексты:

- пауза: «У тебя закончились лимиты (Codex LB). Срочно сохрани промежуточный
  результат: что сделано, что осталось, какие файлы изменены. Затем остановись
  и жди моего сообщения — ничего не продолжай сам.»
- продолжить: «Лимиты восстановлены. Продолжи с места остановки.»

## Retry-on-error

Выключен по умолчанию (`/autoresume retry on` для включения). Когда провайдер
вернул retryable-ошибку (HTTP 429/5xx или текст про rate-limit/overload в
упавшем ходе), плагин тут же опрашивает API:

- лимиты по API есть → сразу шлёт **тот же resume-текст** (сессия после ошибки
  в idle — ход стартует мгновенно);
- лимиты реально низкие → молчит, отрабатывает обычная пауза;
- API недоступен → молчит.

Защита от цикла: cooldown 120с, максимум 3 срабатывания на 30 минут
(исчерпан — только предупреждение человеку), сброс бюджета успешным ходом.
Срабатывания видны в `/autoresume status` с пометкой источника.

Пока сессия в состоянии PAUSED ретраи не стреляют — продолжением владеет
линия refill.

## Команды

| Команда | Эффект |
|---|---|
| `/autoresume` или `status` | Пороги, состояние, свежесть опроса, retry-бюджет — без секретов |
| `/autoresume toggle` | Вкл/выкл |
| `/autoresume pause <pct>` | Линия паузы |
| `/autoresume resume <pct>` | Линия продолжения |
| `/autoresume poll <sec>` | Интервал опроса (мин 15) |
| `/autoresume watch <any\|5h\|7d>` | Какие окна смотреть |
| `/autoresume retry <on\|off>` | Вкл/выкл retry-on-error |
| `/autoresume retry-cooldown <sec>` | Cooldown ретраев |
| `/autoresume retry-max <n>` | Бюджет ретраев на 30 мин |
| `/autoresume msg-pause <текст>` | Свой текст паузы |
| `/autoresume msg-resume <текст>` | Свой текст продолжения |
| `/autoresume set-url <url>` | Сохранить эндпоинт и опросить |
| `/autoresume set-token <token>` | Сохранить токен (0600) и опросить |
| `/autoresume config` | Файлы настроек, источники полей, маскированный токен |
| `/autoresume test-pause` / `test-resume` | Отправить текст без смены состояния |

## Разработка

```sh
npm test        # node --test, zero deps
```

Структура:

- `src/autoresume.ts` — чистая логика: пороги, гистерезис, retry-бюджет, классификация ошибок
- `src/config.ts` — свой config.json (0600) + fallback к файлу pi-codexlb-usage для endpoint/token, env побеждает по́льно
- `src/sources/codexlb.ts` — fetch + маппинг `limits[]` (порт `server/usage.ts` из paseocodexlbusage на zero-deps)
- `src/extension.ts` — wiring хоста (события, таймеры, `/autoresume`)

## Благодарности

- Маппинг codex-lb `limits[]`: [king-of-Jupiter/paseocodexlbusage](https://github.com/king-of-Jupiter/paseocodexlbusage).
- Данные: [Soju06/codex-lb](https://github.com/Soju06/codex-lb).

MIT
