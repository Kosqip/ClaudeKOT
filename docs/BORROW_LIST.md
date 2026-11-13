# Что взять у других проектов (сводка исследований 2026-11-13)

Источник — пять параллельных исследований рынка, объединения подписок, подписки вместо токенов, оркестраторов и computer use. Звёзды и даты сторонних проектов не проверялись. Сайты agenthouse.org, reasonmachines.com, parallelcode.app, jetbrains.com не открылись — по ним данных нет.

## Правила, которые не нарушаем (вывод исследования)

- Законно: каждый сервис только через свой неизменённый официальный CLI под входом пользователя, оркестрация снаружи. Это наша схема.
- Запрещено Anthropic и блокируется с января–апреля 2026: прокси «подписка → API», вход claude.ai в сторонних программах, пулы аккаунтов (CLIProxyAPI, прокси-режимы CCS/claude-code-proxy, relay-сервисы).
- Нежелательно: ротация нескольких своих аккаунтов Claude (лимиты рассчитаны на «ordinary, individual usage»). Передавать задачу другому сервису, а не другому аккаунту.
- Политики менялись несколько раз за 2026 год — перечитывать раз в пару месяцев: code.claude.com/docs/en/legal-and-compliance, support.claude.com/en/articles/15036540.

## Список заимствований

Приоритет: **A** — делать первым, **B** — потом, **C** — по необходимости, **—** — не брать.

### Совместная работа над одной задачей

| # | Что | Откуда | Приоритет | Как ложится на ClaudeKOT |
|---|---|---|---|---|
| 1 | Режим Pair: писатель ↔ ревьюер (ревьюер только читает); стоп при трёх условиях — писатель «готово», нет серьёзных замечаний, проверка прошла; предел кругов; тупик решает пользователь | Audatic07/duo | A | Круги в `executeRun` оркестратора |
| 2 | «Комиссия» / Debate: независимые ответы вслепую → общий список утверждений → голосование | duo, paseo-committee, Claudexor (совет) | A | Поверх микса («В несколько сессий») + сводка оркестратором |
| 3 | Review: каждый ревьюер подтверждает или отклоняет находки других; находки, найденные двумя, — самые надёжные | duo, Claudexor (ревью-панель моделей разных семейств) | A | Режим ревью diff |
| 4 | Цепочка ревью от дешёвого к сильному (например, Sonnet → Opus → Codex) с отдельным JSON-результатом каждого | Z-M-Huang/claude-codex-gemini | B | Цепочка в оркестраторе |
| 5 | Состояния задачи: работает → ждёт ревью → правит замечания → принято; агент не завершён, пока его явно не отпустили | zetbrush/multiagents | B | Статусы подзадач оркестратора |
| 6 | Агент сам вызывает агента другого провайдера посреди работы (инструмент «спросить Codex») | Paseo | B | MCP-инструмент, который запускает ход в сессии другого бэкенда |
| 7 | Пути Express / Standard: простая задача — один исполнитель + ревью; сложная — фазы с подтверждениями; финал блокируется при открытых критичных замечаниях | josstei/maestro-orchestrate | C | Роутер по типу задачи |
| 8 | Компактная запись «места» в цепочке: `provider:model@effort+persona` | duo | C | Настройка цепочек ролей |

### Параллельная работа

| # | Что | Откуда | Приоритет | Как ложится на ClaudeKOT |
|---|---|---|---|---|
| 9 | Отдельная рабочая копия (git worktree) на каждого агента — пишущие подзадачи идут параллельно без конфликтов, слияние в конце | Orca, Paseo, Claudexor, Emdash | B | Модуль worktrees уже есть от оригинала; подключить к оркестратору |
| 10 | Best-of-N: несколько вариантов одной задачи параллельно, выбор лучшего | Claudexor | C | Поверх п. 9 |

### Лимиты и эстафета

| # | Что | Откуда | Приоритет | Как ложится на ClaudeKOT |
|---|---|---|---|---|
| 11 | Экран учёта лимитов: расход и время сброса по каждой подписке, переключение заранее, а не после отказа | Orca («Usage & Accounts»), Claudexor | A | Есть живой % для Claude; добавить Codex и общий экран |
| 12 | Остаток лимита Claude читать из `rate_limits` (данные statusline: `five_hour`, `seven_day`, `used_percentage`, время сброса), а не из текста ошибки | исследование Anthropic-доков | A | Детектор лимитов |
| 13 | «Fail fast»: ошибки, которые повтор не исправит (устаревший CLI, просроченный вход, неизвестная модель), — сразу ошибка; лимит — пауза или передача | duo | A | Детектор лимитов + эстафета |
| 14 | Типизированный сигнал лимита (`fail / ask / rotate`) вместо распознавания текста | Claudexor | B | Детектор лимитов |
| 15 | Передача контекста через файл в папке проекта (`.agent-handoff/latest.md`) | TStansel/handoff | — | Уже есть (файл истории); для Custom API — текст в сообщении |
| 16 | Отдача работы в Codex на 70/85/95 % лимита | codex-mode | — | Уже есть (порог предложения переноса) |

### Запуск CLI

| # | Что | Откуда | Приоритет | Как ложится на ClaudeKOT |
|---|---|---|---|---|
| 17 | Постоянно запущенные CLI (`claude -p --input-format stream-json`, `codex app-server`): сообщение агенту посреди хода, возобновление той же сессии после сбоя, расход токенов из `thread/tokenUsage/updated` | zetbrush/multiagents | C | **Меняет способ запуска CLI — запрещено правилами проекта без решения пользователя** |

### Computer use (только по явной команде пользователя — правило проекта)

| # | Что | Откуда | Приоритет | Как ложится на ClaudeKOT |
|---|---|---|---|---|
| 18 | Cua Driver как MCP-сервер (`cua-driver mcp`): Claude Code / Codex сами решают, MCP выполняет скриншоты, клики, ввод — оплата по подписке | trycua/cua | B | Переключатель + показ скриншотов, как в Browser Use. Ставить только `--only cua-driver`, без облачной части; пакет `cuabot` не трогать |
| 19 | Настоящий фон на Windows 10 — только отдельная машина: Windows Sandbox, ВМ Hyper-V (Win10 Pro) или Linux-контейнер с Xvfb | исследование computer use | B | Запускать Cua Driver внутри песочницы |
| 20 | Linux-контейнер с виртуальным экраном + MCP (Docker Desktop + WSL2) | supercorp-ai/computer-use-mcp, образ cua linux | C | Только браузер/Linux — почти дублирует Browser Use |
| 21 | Движок UFO для чтения дерева элементов окна Windows как отдельный MCP-инструмент | microsoft/UFO | C | Отдельная работа |

## Чего не брать

- Прокси «подписка → API», пулы и ротация аккаунтов (CLIProxyAPI, CCS в режиме прокси, relay).
- «Каналы» desktop-cc-gui — переводят Claude Code на API-оплату, против цели проекта.
- Протокол ACP (Harnss, acp-ui, agent-team) — много агентов не нужно, Claude/Codex/OpenRouter уже подключены.
- OmniParser, UI-TARS, Agent S, циклы UFO — нужны свои модели, API-ключи или видеокарта; UI-TARS Remote отправляет экран в облако ByteDance.
- Jam, Cortex — конкурирующие платформы, только как образец архитектуры.
- Мобильные приложения, облако, удалённые серверы (Orca, Paseo) — к задаче не относятся.

## Порядок работ

1. Сначала проверить ядро вживую: `codex login`, роли (Claude — оркестратор, Codex — руки, Custom API — рутина), один запуск оркестратора, одно ручное переключение бэкенда. Без этого всё ниже строится вслепую.
2. Пункты A: Pair (1), комиссия (2), Review (3), учёт лимитов (11–12), fail fast (13).
3. Пункты B: worktrees в оркестраторе (9), цепочка ревью (4), состояния (5), агент-вызывает-агента (6), сигнал лимита (14), computer use через Cua в песочнице (18–19).
4. Пункты C — по необходимости.

## Источники

orca: github.com/stablyai/orca · paseo: github.com/getpaseo/paseo · claudexor: github.com/razzant/claudexor · duo: github.com/Audatic07/duo · multiagents: github.com/zetbrush/multiagents · maestro: github.com/josstei/maestro-orchestrate · claude-codex-gemini: github.com/Z-M-Huang/claude-codex-gemini · agent-team: github.com/nekocode/agent-team · handoff: github.com/TStansel/handoff · codex-mode: github.com/bambushu/codex-mode · desktop-cc-gui: github.com/zhukunpenglinyutong/desktop-cc-gui · harnss: github.com/OpenSource03/harnss · acp-ui: github.com/formulahendry/acp-ui · emdash: github.com/generalaction/emdash · cua: github.com/trycua/cua · computer-use-mcp: github.com/supercorp-ai/computer-use-mcp · jam: github.com/Dag7/jam · cortex: github.com/CortexPrism/cortex · OmniParser: github.com/microsoft/OmniParser · UI-TARS: github.com/bytedance/UI-TARS-desktop · UFO: github.com/microsoft/UFO · Agent S: github.com/simular-ai/Agent-S · правила Anthropic: code.claude.com/docs/en/legal-and-compliance
