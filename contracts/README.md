# InversePool — контракт по SPEC.md §2, §4–§9, §11

Один файл `InversePool.sol`, solidity ^0.8.24, без импортов (Ownable2Step, ReentrancyGuard,
FullMath, TickMath написаны внутри). ABI — `out/InversePool.abi.json`.

> **Статус на 29.10.2026:** покрыт тестами Foundry (юнит, фазз, инварианты, форк RH Chain) — все
> зелёные; найдено и исправлено 6 багов (см. ниже). **Аудита нет**, в сеть не деплоился: живая
> RH проверялась только через `eth_call` и форк.

## Сборка

Деплоить **только через via-IR**: legacy-кодоген даёт больше 26 КБ рантайма — больше лимита
EIP-170 (24 576). Via-IR + optimizer 200 даёт 22 003 байта (запас 2,5 КБ).

```powershell
# из inverse-rh/contracts, PowerShell (сеть из Bash-инструмента тут не ходит)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
cmd /c "npx --yes solc@0.8.28 --standard-json --base-path . < solc-input.json > out\InversePool.json"
# solcjs печатает строку ">>> Cannot retry compilation with SMT..." перед JSON — её надо отрезать при парсинге
```

`solc-input.json` — standard-JSON (viaIR, optimizer 200, evm cancun). Его же можно
отдать в верификацию на эксплорере (подставив `content` вместо `urls`).
`foundry.toml` повторяет те же настройки, так что `forge build` даёт тот же контракт.

## Тесты

Foundry 1.7.1 стоит в `%USERPROFILE%\.foundry\bin` (не в PATH). forge-std не в репо:

```powershell
$env:PATH = "$env:USERPROFILE\.foundry\bin;$env:PATH"
git clone --depth 1 --branch v1.9.7 https://github.com/foundry-rs/forge-std lib/forge-std
forge test                                   # юнит + фазз + инварианты, форк-тесты пропускаются
$env:RH_FORK = "true"; forge test --match-contract ForkRH -vv   # форк головы RH (публичная нода)
powershell -File script/rh-live-check.ps1    # ArbSys глазами контракта на живой RH, только eth_call
```

Кампания потяжелее: `$env:FOUNDRY_INVARIANT_RUNS=512; $env:FOUNDRY_INVARIANT_DEPTH=128; forge test --match-contract Invariant`.

**Ловушка via-IR в тестах:** оптимизатор кэширует `block.number`/`block.timestamp` внутри тестовой
функции, и второй `vm.roll(block.number + 1)` даёт тот же блок. В тестах только
`vm.getBlockNumber()` / `vm.getBlockTimestamp()`.

| Файл | Что | Раздел спеки |
|---|---|---|
| `test/Money.t.sol` | deposit/receive/withdraw только свободного баланса без кипера, реентранси; сессионный ключ: открывает/закрывает/отменяет за владельца, не выводит, не меняет ключи, не трогает доли LP, истекает, не ставит реферера | §2, §5 |
| `test/Trading.t.sol` | заявка блокирует ставку+фи; цена только из блока > блока заявки и не старше `maxPriceAgeBlocks`; плечо ≤ уровня кипера; номинал; 5 % на сторону монеты, 50 % на пул (свежий и протухший отчёт); сплит 75/10/10/5 и 85 % без рефера; пауза owner; PnL лонг/шорт, кэпы +200 %/−100 %, previewClose; удержание 10 с; USER/TP/SL/CAP_WIN/CAP_LOSS проверяются по цене; RUG — только шорты под замком, кэп +20 % на любое закрытие шорта под замком; POOL_GONE по lastPrice; cancel через 60 с; reject | §4, §5, §7, §8, §9 |
| `test/Pool.t.sol` | мёртвые доли; доли по NAV; addLiquidity требует свежий отчёт; вывод через 24 ч и окно исполнения; резерв под max-win не выводится; 7 дней тишины — вывод без задержки; границы и клэмп отчёта; NAV без двойного счёта; пауза при −10 % за час (закрытия работают, снятие owner, окно фиксированное, LP-потоки не размывают); emergencyClose после 24 ч, любой экшен кипера сбрасывает таймер | §9, §11 |
| `test/Oracle.t.sol` | сверка пула с фабрикой (fee- и tickSpacing-ключи), ориентация token0/token1, decimals, округление отрицательного тика вниз, ±3 % к TWAP на open и close, OracleUnavailable, аварийное закрытие по TWAP и по lastPrice, сброс v3-сверки только owner; ArbSys: номера блоков из прекомпайла, фолбэк на `block.number`; роли, `setParams`, призы, ops; фазз выплаты по формуле | §6, §11 |
| `test/Invariant.t.sol` | хендлер всех ролей (21 действие) + 5 инвариантов: `poolCash ≥ totalReserved`; `accountingSurplus() == 0` и баланс контракта = сумма корзин; escrow/резерв/открытые ставки/номиналы по рынкам пересобираются из позиций, сумма балансов = `totalBalances`; доли сохраняются; NAV в `[poolCash − reserved, poolCash + openStake]`. Плюс детерминированный проход 6000 шагов, доказывающий, что каждая ветка реально исполняется | §9, §11 |
| `test/ForkElysium.t.sol` | форк головы Elysium testnet: деплой, фабрика v3 (fee-ключ) проверяется, кардинальность 1 у пулов и её подъём, полный цикл v4-монеты в HYPE | §2, §5, §6 |
| `test/ForkRH.t.sol` | форк головы RH: observe и кардинальность живых пулов, контракт читает цену через Uniswap v3, Aero и форки лаунчпадов, сделка open→close против живого observe, `increaseObservationCardinalityNext` открыт | §6 |

Итог прогона: 102 юнит/фазз-теста, 5 инвариантов × 65 536 вызовов, 7 форк-тестов — зелёные.

## Найденные и исправленные баги

Каждое исправление проверено мутацией: откат одного фикса валит перечисленные тесты.

1. **Сессионный ключ навсегда ставил реферера владельцу.** Первая сделка через `requestOpenFor` с
   `referrer = ключ` закрепляла реферера: украденный ключ получал 10 % всех будущих комиссий
   трейдера. Теперь реферера ставит только сам трейдер. Тест: `test_key_cannot_bind_referrer`.
2. **NAV дважды считал реализованный PnL.** Закрытая позиция оставалась в отчёте кипера до
   следующего отчёта (до часа), а её PnL уже сидел в `poolCash`. Выигрыш трейдера вычитался из NAV
   дважды (новый LP получал лишние доли), проигрыш прибавлялся дважды (уходящий LP забирал чужое).
   Теперь при закрытии позиции, открытой до отчёта, её PnL вычитается из `reportedUnrealized`.
   Тесты: `test_nav_does_not_double_count_realized_win/_loss`, `test_positions_opened_after_report_are_not_netted`.
3. **Пауза «−10 % за час» не видела денег LP.** База окна фиксировалась в начале окна: крупный
   вывод LP внутри окна оставлял старую базу, и остаток пула мог потерять гораздо больше 10 % без
   паузы (тест: пул 1000 → вывод 900 → потеря 15 % остатка, паузы не было); депозит, наоборот,
   давал ложную паузу. Теперь вход/выход LP масштабирует базу и итог окна пропорционально
   (`_rescaleWindow`). Тесты: `test_lp_exit_does_not_dilute_pause`, `test_lp_deposit_does_not_false_pause`.
4. **Заявка LP на вывод не истекала.** Одна заявка, поданная когда-то, давала мгновенный выход в
   любой момент — 24-часовая задержка из §9 обходилась навсегда. Теперь после созревания у заявки
   есть окно `removeWindow` (24 ч), потом `RemoveExpired`: отменить и подать заново.
   Тест: `test_remove_request_expires_after_window`. Остаток риска — в разделе «Не проверено».
5. **Окна в блоках рассчитаны на 250 мс, а RH делает ~9,6 блока/с** (замер 29.10: 100 000 блоков
   за 10 381 с). `rugWindowBlocks = 120` было 12,5 с вместо 30 с — руг, растянутый на 13–30 с,
   `flagRug` отклонил бы; `maxPriceAgeBlocks = 240` было 25 с вместо 60 с. Теперь 300 и 600.
   Тест: `test_defaults_match_spec`.
6. **Проба ArbSys в конструкторе без лимита газа.** На форке RH (anvil/forge) в 0x64 лежит
   заглушка `0xfe` без прекомпайла: вызов сжигал 63/64 газа, деплой на форк падал по газу
   (репетиция деплоя на anvil-форке была бы невозможна). Теперь `staticcall{gas: 50_000}`; на живой
   RH этого хватает (проверено `eth_call`). Тест: `test_deploy_on_fork_without_precompile_is_cheap`.

## Итог проверок на живой RH (29.10.2026, головной блок ~100 377 000)

- **ArbSys** (`script/rh-live-check.ps1`, `eth_call` на закреплённом блоке N): внутри EVM
  `block.number = 26 293 855` — это блок Ethereum L1, а `arbBlockNumber() = N`. Настоящий конструктор
  InversePool на RH даёт `USE_ARBSYS = true`, `blockNumber() = N`. Опасение из исходного README
  подтвердилось: с `block.number` двухшаговое исполнение сломалось бы.
- **Форк в forge/anvil не исполняет прекомпайлы Nitro:** там `USE_ARBSYS = false` и
  `block.number` = номер L2-блока, поэтому форк-тесты идут на `block.number`, а ArbSys проверяется
  только живым скриптом.
- **observe([30,0])** отвечает с тем же ABI у Uniswap v3 (`0x1f7d…2EfA`), Aero Slipstream
  (`0xc63d…E136`; `slot0` у него из 6 полей, без `feeProtocol`, на контракт не влияет) и у форков
  лаунчпадов `0x1ac9…`, `0xE0c4…` (ключ фабрики — tickSpacing, `setFactory(f, 2)`) и `0xE519…`
  (ключ — fee, `setFactory(f, 1)`). Фабрика `0x1649…` — **не v3 ABI** (нет `slot0`/`observe`):
  такие пулы ончейн-сверку не пройдут.
- **Кардинальность наблюдений** у живых пулов: Uniswap WETH/USDG 10 816 и 23 000, SPY/WETH 5 831,
  SPCX/WETH 8 014, Memelord/WETH **1**; Aero WETH/USDG 900, мемкоины/WETH на Aero — 900, 301 и **1**;
  форки лаунчпадов 3 601 / 128 / 64. При кардинальности 1 `observe` падает, если своп был < 30 с
  назад (Memelord на форке упал). `increaseObservationCardinalityNext` открыт для всех (проверено).
- Контракт читает цену через живые пулы: 1 USDG = 4,2386e14 wei (ETH ≈ $2 359), Uniswap и Aero
  совпадают до wei; сделка open → close против живого `observe` проходит; деплой ≈ 5,19 млн газа.

## v1.1 (06.11.2026, под Elysium)

Правки P0 из [STYX-ELYSIUM.md §3.3](../STYX-ELYSIUM.md). Рантайм **24 269 / 24 576 байт** (запас 307).
Чтобы влезть, событие `ParamsUpdated` теперь несёт хеш параметров, а пять view (`freeCash`, `reportFresh`,
`keeperSilentFor`, `liabilityBase`, `lpValue`) убраны: они считаются из публичных полей.

| Что | Как | Где проверено |
|---|---|---|
| Окно исполнения | `executeOpen` и USER-`executeClose` берут цену только из `[B+minExecDelayBlocks, B+maxExecDelayBlocks]` (Elysium 1/20 ≈ 2 с), плюс свежесть `maxPriceAgeBlocks` | `WindowTest` |
| Потолок над кипером | `notionalCapMax` урезает `notionalCap` кипера; `guardian` может только поставить паузу | `CeilingTest` |
| Адаптер цены | `Market.priceAdapter` (owner) и общий `defaultAdapter` (owner, `setRoles`) для рынков без v3-пула; `IPriceSource.quote` через STATICCALL | `AdapterTest` |
| `V4SpotSource` | Полоса к споту v4-пула (`extsload`, слот 6): ≤ 2 % выгоднее трейдеру, ≤ 5 % хуже (3 % для SL/CAP/RUG). Фид ставит кипер полным `PoolKey`, хук — из белого списка владельца, `PoolId` выводится в адаптере. Поле `fee` не проверяется: пулы лаунчпадов Elysium объявляют 0, комиссию берёт хук | `V4SpotSourceTest`, e2e на anvil |
| Оракул v3 | Листинг требует `observationCardinalityNext > emergencyTwapWindow` (900); `emergencyClose` v3 идёт по 900-с TWAP и откатывается, пока `observe` не отвечает (больше не падает на `lastPrice`) | `OracleTest`, форки RH и Elysium |
| Двойные часы | Тишина кипера = время **и** L2-блоки (`keeperBlockRate`, Elysium 2/с): простой секвенсера не открывает аварийный режим | `DualClockTest` |
| Ребейты и излишек | Перевод от `rebateSource` → призовой котёл; `sweepSurplus()` — открытый | `MoneyV11Test` |
| `withdrawOps` | Только на кипера или `treasury` | `OracleTest` |
| Охраняемый запуск | `setLpAllowed(0, on)` включает гейт LP, `maxPoolCash` — потолок кассы | `MoneyV11Test` |

Значения по умолчанию в конструкторе оставляют поведение v1 (окно 600, двойные часы выключены). Значения под Elysium
выставляет `script/Deploy.s.sol`. Из P1 не сделана «капельница» газа в `setSessionKey`: в контракте нет на неё байтов,
ключ пополняет сайт отдельным переводом.

**Правки по ревью 06.11** (45 агентов: 4 линзы и скептик на каждую находку; 39 подтверждено, 2 опровергнуто):
- `flagRug` **больше не пишет `lastPrice`**. Раньше его цены не проверялись, а `POOL_GONE` и аварийное закрытие брали
  `lastPrice`, так что ключ кипера мог провести через это любую цену мимо полосы (доказано тестом).
  Теперь `lastPrice` пишут только сделки, прошедшие полосу или TWAP. Тест: `test_flagRug_does_not_set_the_settlement_price`.
- `setMarketSource`: переключать рынок между полосой и v3-TWAP в любую сторону может только владелец. Кипер
  может лишь заменить один проверенный v3-пул на другой.
- `V4SpotSource.setFeed`: кипер ставит первый фид, а перенаправить живой фид может только владелец.
- `keeperBlockRate` теперь в блоках **в час**. Nitro не делает пустых блоков, и на тихой цепи порог «2 блока/с»
  откладывал бы аварийный выход на недели.
- В деплое: max-win на монету 2% (охраняемый запуск), ключ кипера обязан отличаться от владельца.

Размер после правок — 24 247 байт. Тесты: 137 + 11 форков (RH 7, Elysium 4), все зелёные.

## Деплой

Скрипт: `script/Deploy.s.sol` (сети `elysium` и `rh`, подпись из keystore Foundry, не из env):

```bash
cast wallet import inverse-deployer --interactive
NETWORK=elysium forge script script/Deploy.s.sol --rpc-url elysium --account inverse-deployer --broadcast
```

Перед деплоем проверить живую цепь: `powershell -File script/live-check.ps1 -Net elysium`
(только `eth_call`: ArbSys, конструктор, оценка газа). Форк: `ELY_FORK=1 forge test --match-contract ForkElysium -vv`.
На Elysium `weth` — это WHYPE `0xCD57…F234`, нативка HYPE. Контракт тот же, ETH в комментариях означает нативку.

`constructor(address weth, address keeper)`:
- `weth` — WETH RH Chain (`0x0Bd7…AD73`). V3-пул монеты принимается, только если это пара token/WETH.
- В конструкторе контракт сам определяет, есть ли ArbSys (0x64). **На Nitro `block.number` —
  это блок родительской цепи (Ethereum)**, а не блок RH. Поэтому все `requestBlock`/`priceBlock` берутся из
  `ArbSys.arbBlockNumber()` (вне Arbitrum — из `block.number`). См. `blockNumber()`.
- После деплоя: `setFactory(factory, 1)` для фабрик с `getPool(a,b,fee)` (Uniswap v3, `0xE519…`),
  `setFactory(factory, 2)` для `getPool(a,b,tickSpacing)` (Aero Slipstream, `0x1ac9…`, `0xE0c4…`).
  Без этого `addMarket` с v3-пулом не пройдёт.
- Uniswap v3 и Slipstream пишут **одно наблюдение в секунду** (по `block.timestamp`, не по блоку),
  поэтому для TWAP 30 с нужно ≥ 31 слота. Перед листингом поднять `increaseObservationCardinalityNext`
  (вызов открытый) до 64 у пулов с маленькой кардинальностью — иначе `observe([30,0])` падает, если
  в пуле был своп за последние 30 с, и кипер не сможет исполнять сделки по монете (`OracleUnavailable`).
  Новые слоты заполняются по мере свопов, так что поднимать заранее.

## Раздел спеки → функции

| § | Что | Функции |
|---|---|---|
| §2 Деньги | внутренний баланс в нативном ETH, вывод без оператора, мин. ставка | `deposit()`, `receive()`, `withdraw(amount)`, `balanceOf`, параметр `minStake` |
| §4 Позиция | плечо 2/5/10, PnL, кэпы +200 % / −100 %, комиссии 1 % + 1 %, сплит 75/10/10/5, удержание 10 с | `_pnl`, `_rawPnl`, `_settle`, `_distributeFee`, `previewClose(id, price)`; события `FeeSplit`, `ReferrerSet` |
| §5 Исполнение | заявка → кипер, `priceBlock > B`, отмена через 60 с, сессионный ключ на 24 ч | `requestOpen(...)`, `requestOpenFor(trader, ...)`, `requestClose(id)`, `cancelRequest(id)`, `executeOpen(id, price, priceBlock, maxLeverage, notionalCap)`, `executeClose(id, price, priceBlock, reason)`, `rejectRequest(id, code)`, `setSessionKey(key, expiry)`, `isSessionKey` |
| §6 Цена | `lastPrice`, сверка с TWAP 30 с для v3/Aero CL (±3 %), пул и блок в каждом событии | `_checkOracle`, `_twapPrice`, `_quoteAtTick`, `oraclePrice(marketId)`, `getMarket(id)`; поле `priceSource` в `PositionOpened` / `PositionClosed` / `RugFlagged` |
| §7 TP/SL/кэпы | контракт сам проверяет условие по переданной цене | `executeClose` с `TP`/`SL`/`CAP_WIN`/`CAP_LOSS` → `_checkReason` |
| §8 Rug guard | падение ≥80 % за ≤30 с: шорты урезаются до +20 %, монета закрыта на 1 ч; пул пропал → закрытие по последней цене | `flagRug(marketId, priceBefore, blockBefore, priceAfter, blockAfter)`, `executeClose(..., RUG)`, `setMarketEnabled(id,false)` + `executeClose(..., POOL_GONE)` |
| §9 Пул LP | доли по NAV, NAV = cash − нереализованный PnL, вывод через 24 ч, лимиты 5 % / 50 %, пауза при −10 % за час | `addLiquidity()`, `requestRemove(shares)`, `executeRemove(rid)`, `cancelRemove(rid)`, `reportUnrealized(value, asOf)`, `nav()`, `lpValue(lp)`, `liabilityBase()`, `freeCash()`, `_reserve`, `_poolDelta`, `_rescaleWindow`, `clearLossPause()` |
| §11 Аварийный выход | 24 ч без кипера → кто угодно закрывает по `lastPrice`/TWAP; 7 дней → LP без задержки | `emergencyClose(id)`, `executeRemove` (ветка `lpEmergencyDelay`), `keeperSilentFor()` |
| Роли | owner в две ступени, киперы, фабрики, параметры | `transferOwnership`, `acceptOwnership`, `setKeeper`, `setFactory`, `setParams`, `getParams`, `setPaused`, `addMarket`, `setMarketSource`, `setMarketEnabled`, `distributePrizes`, `withdrawOps` |
| Аудит учёта | баланс контракта = сумма всех корзин | `accountingSurplus()` (не должен быть < 0), `totalBalances`, `totalEscrow`, `poolCash`, `prizePool`, `opsBalance` |

Все пороги — в `Params` (bps и секунды), дефолты из спеки ставятся в конструкторе.
`setParams` ограничен сверху, чтобы опечаткой нельзя было сломать закрытия
(переполнение) или запереть пользователей (задержки ≤ 7–30 дней).

## Отступления от спеки и решения по ходу

1. **`requestOpenFor(trader, ...)`** вдобавок к `requestOpen(...)`. Сессионный ключ открывает
   через `...For` с явным владельцем. Неявное «ключ → владелец» позволяло бы кому угодно
   прописать чужой адрес своим ключом и на 24 ч увести его сделки на свой счёт.
   `requestClose` и `cancelRequest` берут владельца из позиции, им это не нужно.
2. **Реферер закрепляется за трейдером** при его первой сделке (`referrerOf`) и только когда заявку
   шлёт сам трейдер: сделки через сессионный ключ реферера не ставят (баг 1).
3. **Rug — в два шага.** Сначала кипер вызывает `flagRug` с ценой и блоком до и после
   (проверяется: падение ≥ `rugDropBps`, блоки в пределах `rugWindowBlocks`). Это закрывает
   монету на 1 ч. Пока замок висит, **любой** закрываемый шорт по монете урезается до +20 %,
   включая закрытия USER и TP, а не только `RUG`. Сами цены «до/после» ончейн не проверяются
   (TWAP после обвала отстаёт): они в событии, чтобы аудитор поймал подлог. Для v3-монет
   `executeClose(..., RUG)` пройдёт сверку ±3 % только когда TWAP догонит обвал (~30 с) — в пределах
   часового замка это не мешает.
4. **POOL_GONE** допустим только для отключённого рынка (`setMarketEnabled(id,false)`). Цена
   кипера игнорируется, берётся `lastPrice`.
5. **Минимальное удержание** проверяется для USER и TP. SL / CAP / RUG / POOL_GONE защитные и
   срабатывают сразу.
6. **Свежесть цены:** везде `priceBlock ≤ текущий` и не старше `maxPriceAgeBlocks` (600 ≈ 60 с при
   ~9,6 блока/с на RH). Для открытия ещё `priceBlock > requestBlock`, для закрытия
   `priceBlock ≥ entryBlock`, для USER `priceBlock > блок заявки на закрытие`. `rugWindowBlocks` = 300 ≈ 30 с.
7. **Лимиты 5 % / 50 %** считаются от `min(poolCash, NAV)`. Плюс инвариант
   `poolCash ≥ totalReserved`: LP не может вывести деньги, зарезервированные под max-win
   открытых позиций (`InsufficientFreeCash`), поэтому выплата выигрыша не упирается в пустой пул.
8. **NAV.** Отчёт кипера ончейн обрезается до `[-totalOpenStake, +totalReserved]`. Если отчёт
   старше 1 ч, NAV = `poolCash − totalReserved`. `addLiquidity` при открытых позициях **требует
   свежий отчёт**, иначе новый LP получил бы доли по заниженному NAV. Первый депозит сжигает
   1000 долей (защита от инфляции долей). Закрытие позиции, открытой до отчёта, вычитает её
   реализованный PnL из отчёта (баг 2).
9. **Пауза при −10 %** считается по реализованным потерям пула (выигрыши трейдеров минус доля
   пула в комиссиях) в фиксированном часовом окне от `poolCash` на начало окна; вход и выход LP
   внутри окна масштабируют базу и итог пропорционально (баг 3). Нереализованный
   PnL не учитывается. Окна фиксированные: два раза по −9,9 % на стыке окон паузу не включат.
10. **«Жив ли кипер»** — любая транзакция кипера: execute*, reject, flagRug, reportUnrealized.
    Иначе тихая ночь без сделок через 24 ч открыла бы `emergencyClose` для всех по старой цене.
    Значит, кипер, который сам цензурит заявки, но шлёт отчёты, аварийный режим не включит.
11. **V3-пул проверяется ончейн:** `factory()` пула должна быть в `setFactory`, а
    `factory.getPool(token0, token1, fee|tickSpacing)` должна вернуть этот же пул. Флаг
    token-is-token0 не передаётся, а вычисляется. Убрать v3-пул у рынка (отключить сверку
    с TWAP) может только owner. Кипер может только поменять его на другой проверенный.
12. **Сверка с TWAP строгая:** если `observe` недоступен, `executeOpen` и `executeClose`
    падают (`OracleUnavailable`). В аварийном закрытии при сбое `observe` берётся `lastPrice`.
13. **Лимиты значений:** ставка ≤ 2^96, цены ≤ 2^128, decimals ≤ 36, чтобы PnL и пересчёт тика
    гарантированно не переполнялись.
14. **Призы и ops.** `prizePool` раздаёт owner через `distributePrizes` (на внутренние балансы),
    `opsBalance` выводит owner через `withdrawOps` (газ кипера).
15. **Окно исполнения вывода LP.** Созревшую заявку надо исполнить за `removeWindow` (24 ч), иначе
    `RemoveExpired` — отменить и подать заново (баг 4). При 7 днях тишины кипера окно, как и
    задержка, не действует.

## Что остаётся на доверии кипера

Цена для v4-монет; размер `maxLeverage` и `notionalCap` (D10 считается офчейн); выбор основного
пула; цены в `flagRug`; решение «пул пропал»; снапшот нереализованного PnL (в пределах
ончейн-границ). Всё это попадает в события с пулом и блоком, но ончейн не опровергается.

## Не проверено

- **Аудита нет.** Тесты проверяют спеку и учёт, а не всё, что может придумать атакующий.
- В сеть не деплоился, реальных транзакций не было: живая RH — только `eth_call` (ArbSys,
  конструктор) и форк. Газ с L1-составляющей Nitro не мерился.
- Связка с движком: `engine/` пока не зовёт контракт (режим Practice), кипер не написан.
- v4-монеты: ончейн-оракула нет, проверена только логика с ценой кипера.
- Экономика лимитов (5 % / 50 %, 0.2·D10, пороги плеча) не проверялась на исторических данных.
- Остаточные риски дизайна, не баги кода:
  - LP может держать две заявки на вывод со сдвигом и иметь половину долей «на выходе» почти
    всегда; короче `removeWindow` — меньше эта доля (при 1 ч — ~4 %).
  - При мёртвом кипере `emergencyClose` для v3 берёт 30-с TWAP без сверки ±3 %: тонкий пул можно
    продержать сдвинутым 30 с и закрыть свою позицию по сдвинутой цене; для v4 — по старой `lastPrice`.
  - Сверка ±3 % к 30-с TWAP: при резком движении SL/CAP кипера не пройдут, пока TWAP не догонит
    (убыток трейдера всё равно ограничен −100 %). Движку стоит обрезать цену филла закрытия до ±3 % от TWAP.
  - Фиксированные часовые окна паузы (см. решение 9).
