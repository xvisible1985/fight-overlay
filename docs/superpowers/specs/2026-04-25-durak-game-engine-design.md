# Дурак — Спек 2: Игровой движок

**Дата:** 2026-04-25
**Проект:** fight-overlay + nordheimunion.ru
**Статус:** Утверждён

---

## Обзор

Второй этап мини-игры «Дурак». Реализует игровой движок (подкидной и переводной), UI карт в Electron-окне, реконнект, таймауты и выплату выигрыша. Лобби, баланс и приглашения реализованы в Спеке 1.

---

## База данных (сервер nordheimunion.ru)

### Изменения в `game_tables`

Два новых поля (добавляются через `ALTER TABLE`):

| Поле | Тип | Описание |
|---|---|---|
| `turn_timeout` | integer | Таймаут хода защитника в секундах, default 30 |
| `throw_timeout` | integer | Таймаут подкидывания в секундах, default 10 |

Оба поля задаются создателем стола в форме лобби.

### Новая таблица `game_history`

| Поле | Тип | Описание |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID |
| `table_id` | FK → game_tables | Ссылка на стол |
| `finished_at` | TEXT | datetime('now') |
| `type` | TEXT | `throwing` / `transfer` |
| `bet` | INTEGER | Ставка |
| `result` | TEXT | JSON: `[{user_id, game_name, place, payout}]` |

### Игровое состояние

Хранится **в памяти сервера** (`Map<tableId, GameSession>`). При рестарте сервера активные игры теряются — приемлемо для Спека 2.

---

## Серверная архитектура

Три новых файла:

### `server/game-engine.ts`

Чистая игровая логика без I/O. Принимает состояние + действие, возвращает новое состояние + список событий для рассылки.

**Колода:** 36 карт — 6, 7, 8, 9, 10, J, Q, K, A в 4 мастях. Раздача по 6 карт. Козырь = масть нижней карты остатка колоды.

**Правила подкидного (`throwing`):**
- Атакующий кладёт карты на стол (одного ранга или разных)
- Защитник бьёт каждую карту старшей картой той же масти или любым козырем
- Остальные игроки могут подкинуть карты рангов, уже присутствующих на столе (не больше чем карт в руке у защитника)
- Если защитник не может отбить — берёт все карты со стола
- Если отбил все — карты уходят в сброс

**Правила переводного (`transfer`):**
- Дополнительно: защитник может перевести атаку следующему игроку если у него есть карта того же ранга (только если ещё не начал отбивать)
- Нельзя переводить если у следующего игрока карт меньше чем карт на столе

**После раунда:** все добирают карты из колоды до 6 (атакующий первый, по часовой). Игрок у которого 0 карт и колода пуста — **выходит** с текущим местом.

**Дурак:** последний оставшийся игрок с картами.

**Функции:**
- `createGame(players, type, turnTimeout, throwTimeout)` → `GameState`
- `attack(state, userId, cards[])` → `{state, events[]}`
- `defend(state, userId, attackCard, defendCard)` → `{state, events[]}`
- `transfer(state, userId, card)` → `{state, events[]}` (только переводной)
- `throwIn(state, userId, card)` → `{state, events[]}`
- `pass(state, userId)` → `{state, events[]}`
- `take(state, userId)` → `{state, events[]}`

### Структура `GameState`

```typescript
interface GameState {
  tableId: string
  type: 'throwing' | 'transfer'
  turnTimeout: number       // секунды
  throwTimeout: number      // секунды
  deck: Card[]              // остаток колоды (рубашкой вниз, только count виден клиентам)
  discard: Card[]           // сброс
  trump: Suit               // козырная масть
  trumpCard: Card           // нижняя карта (убирается когда колода кончается)
  hands: Record<string, Card[]>   // userId → карты (клиент видит только свои)
  table: AttackPair[]       // [{attack: Card, defend: Card | null}]
  players: PlayerState[]    // в порядке хода
  attackerIdx: number       // индекс атакующего в players
  defenderIdx: number       // индекс защитника в players
  phase: 'attack' | 'defense' | 'throw' | 'draw' | 'finished'
  passedIds: string[]       // кто уже спасовал в фазе throw
  exits: {user_id: string, place: number}[]  // вышедшие игроки
  timerEndsAt: number | null  // Date.now() + ms когда истекает текущий таймер
}

interface PlayerState {
  user_id: string
  game_name: string
  avatar_url: string | null  // /uploads/warrior-photos/... (первое фото из анкеты)
  gender: 'male' | 'female'  // из profiles.gender — для силуэта
  cardCount: number          // клиент видит только количество у чужих
  connected: boolean
}

interface Card { rank: '6'|'7'|'8'|'9'|'10'|'J'|'Q'|'K'|'A'; suit: '♠'|'♥'|'♦'|'♣' }
type AttackPair = { attack: Card; defend: Card | null }
```

### `server/game-sessions.ts`

Менеджер активных игр в памяти.

```typescript
interface GameSession {
  state: GameState
  sockets: Map<string, WebSocket>  // userId → ws
  turnTimer: NodeJS.Timeout | null
  throwTimer: NodeJS.Timeout | null
}
```

**Функции:** `createSession(tableId, players, type, turnTimeout, throwTimeout)`, `getSession(tableId)`, `endSession(tableId)`

Таймеры: `setTimeout` на ход защитника и на подкидывание. По истечении — вызов `take()` или `pass()` от имени игрока.

### `server/ws-game.ts`

WebSocket-канал `/ws/game/:tableId`.

- JWT-аутентификация через `?token=` (как в `/ws/games`)
- На подключение/реконнект: отправляет полный `game_state` snapshot
- Принимает от клиента: `attack`, `defend`, `transfer`, `throw_in`, `pass`, `take`
- Вызывает `game-engine.ts`, рассылает события всем участникам стола
- Сохраняет сокет в `GameSession.sockets`

### Изменения в существующих файлах

- `server/routes/games.ts` — эндпоинт `/start` вызывает `createSession()` перед броадкастом `game_started`
- `server/index.ts` — монтирует `setupGameWS(server)`
- `server/db.ts` — добавляет поля `turn_timeout`, `throw_timeout` в `game_tables`; создаёт `game_history`

---

## WebSocket события

### Сервер → клиент

| Событие | Когда | Данные |
|---|---|---|
| `game_state` | Подключение / реконнект | Полный снапшот: руки, стол, козырь, колода, чья очередь, секунды таймера |
| `attack` | Атакующий сыграл карты | `{user_id, cards[]}` |
| `defend` | Защитник отбил карту | `{attack_card, defend_card}` |
| `transfer` | Перевод атаки (переводной) | `{user_id, card, next_defender_id}` |
| `throw_in` | Подкинута карта | `{user_id, card}` |
| `round_end` | Раунд завершён | `{taken_by?: user_id, discarded: bool}` + обновлённые руки |
| `player_drew` | Игрок добрал карты | `{user_id, count}` |
| `player_exit` | Игрок вышел (0 карт) | `{user_id, place}` |
| `timer_start` | Запущен таймер | `{type: 'turn'|'throw', user_id, seconds}` |
| `player_reconnected` | Игрок вернулся | `{user_id}` |
| `game_over` | Игра завершена | `{results: [{user_id, game_name, place, payout}]}` |

### Клиент → сервер

| Действие | Данные |
|---|---|
| `attack` | `{cards: [{rank, suit}]}` |
| `defend` | `{attack_card, defend_card}` |
| `transfer` | `{card}` (переводной) |
| `throw_in` | `{card}` |
| `pass` | `{}` |
| `take` | `{}` |

---

## Игровое окно (game-window.html)

### Масштабирование

Базовый размер 860×580px. `ResizeObserver` на корневом элементе вычисляет `scale = min(w/860, h/580)` и применяет `transform: scale(scale)` ко всему содержимому. В Electron: `resizable: true`, `minWidth: 500`, `minHeight: 340`.

### Структура UI

**Заголовок:** название стола, тип, таймер активного игрока, козырь, размер колоды.

**Зона противников** (сверху): слот на каждого игрока — портрет из анкеты (первое фото из `warrior_photos`, прямоугольный, `object-position: top`) или SVG-силуэт по `profiles.gender` (`'male'`/`'female'`), имя, роль (атакует/защищается/ждёт/отключён), рубашки карт. Рамка портрета: красная у атакующего, синяя у защитника, зелёная у меня, серая у ожидающих.

**Стол** (центр, flex: 1 — растягивается): пары атака/защита, козырная карта с колодой, стопка сброса.

**Моя рука** (снизу): мой портрет слева + все карты рубашкой вверх, клик — выбрать/снять выбор.

**Панель действий** (нижняя строка): кнопки меняются по роли:
- Атакующий: **Атаковать** (активна если выбраны карты) / **Пас**
- Защитник: **Отбить** (активна если выбрана пара) / **Взять**
- Переводной — дополнительно: **Перевести**
- Подкидывающий: **Подкинуть** / **Пас**
- Статусная строка по центру: текущая ситуация
- Банк справа: 💰 N монет

**Экран результатов:** всплывает поверх стола по `game_over` — таблица мест и выплат, кнопка **Закрыть**.

### game-preload.cjs (расширяется)

Добавляет к `gameAPI`:
- `connect(tableId, token, srv)` — открывает WS `/ws/game/:tableId`
- `onEvent(cb)` — подписка на все игровые события
- `sendAction(type, data)` — отправка действия на сервер

---

## Реконнект и таймауты

- Отключение = таймеры продолжают идти на сервере
- Авто-ход по таймауту: защитник берёт (`take`), подкидывающий пасует (`pass`)
- Реконнект: `/ws/game/:tableId?token=` → сервер отправляет `game_state` snapshot → клиент восстанавливает UI

---

## Выплата

По событию `game_over`:

**Формула весов:** N игроков, i-й вышедший получает вес `(N - i)`, дурак получает 0.
Сумма весов = `N*(N-1)/2`. Выплата игрока i = `total_bank * weight_i / sum_weights`.

**Пример** (4 игрока, ставка 50, банк 200):
- 1-й: 200 × 3/6 = **100 монет**
- 2-й: 200 × 2/6 = **67 монет**
- 3-й: 200 × 1/6 = **33 монета**
- Дурак: **0 монет**

Дробные остатки добавляются к 1-му месту. Балансы обновляются в `game_balances`. Результат пишется в `game_history`.

---

## Что не входит в этот спек (Спек 3)

- История игр и статистика
- Рейтинговая таблица
- Настройки внешнего вида карт / стола
