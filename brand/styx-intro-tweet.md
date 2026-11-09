## EN — post: what Styx is (подготовлено 06.11.2026)

> Перед публикацией:
> 1. **Хендл и домен не заняты нами.** На 06.11 по RDAP свободны styx.fun и styx.trade; @styx в X занят,
>    @styxfun / @styx_trade по fxtwitter отвечали 404, но эта проверка ненадёжна — проверь вручную при регистрации.
> 2. **Даты в посте нет намеренно.** Practice на мейннете возможен, только когда: вышли адреса мейннета (9.11),
>    в `NETWORKS.elysium` вписаны chainId, WHYPE, USDC, фабрики, и движок с сайтом где-то захощены (сейчас только
>    localhost). Когда это готово — добавь строку «Practice is live: <ссылка>».
> 3. **Чего в посте нет и почему:**
>    - мемов Hyperliquid (PUMP, kPEPE…) «уже в Practice» — лейна Charted в движке ещё нет;
>    - выкупа KNTQ — он по спеке только с Real, через мультисиг, а Real после аудита;
>    - токена и очков — по спеке «токена нет», очки Obols только с первой реальной комиссии;
>    - окна исполнения «~2 с» — это правка контракта v1.1, сейчас контракт гарантирует только «цена из блока
>      после заявки».
> 4. «Real money after the audit» — это обещание. Аудитор пока не выбран (кандидаты в STYX-ELYSIUM.md §3.5).
> 5. Картинки: баннер `out/styx-banner.png`, при желании вторая — страница монеты из Practice.

### Основной вариант (длинный пост, X Premium)

Styx.

Long or short any memecoin on Elysium at 2x, 5x or 10x. One pool in HYPE takes the other side of every trade.

The most you can lose is your stake. There are no margin calls, no liquidation engine and no debt. A 10x position closes when the price moves 10% against you, and that's the whole loss. A win pays up to +200%.

Why it's built for Elysium:

New coins launch on Elysium's launchpads all day, and most of them will never get a Hyperliquid perp. Styx lists them by public rules: a pool older than 2 hours, a $30K+ market cap, real trading in the last day and enough depth. The deeper the pool, the higher the leverage.

Blocks are 100 ms. Your fill price is taken from a block after your order lands, so nobody, us included, knows it when you click.

HYPE is the gas, the margin and the payout. Nothing to wrap.

Next: when Elysium lets contracts read HyperCore, the memes that already have a Hyperliquid perp get priced by the contract itself, straight from the order book.

Positions, the pool and payouts live in one contract. Your free balance withdraws without anyone's signature, and if our keeper goes quiet for a day, anyone can close any position.

Practice mode comes first: live prices, paper HYPE, no wallet. Real money after the audit.

### Короткий вариант (≤ 280 знаков)

Styx: long or short any Elysium memecoin at 2x, 5x or 10x against one HYPE pool.

Worst case is your stake. No margin calls, no liquidations, no debt. Wins up to +200%.

The coins Hyperliquid won't list, priced from their own pools. Practice first, real money after the audit.

### Тред (4 поста)

**1/**
Styx: long or short any memecoin on Elysium at 2x, 5x or 10x.

One pool in HYPE takes the other side of every trade. No order book, no waiting for a counterparty, and shorting a coin doesn't sell a single token of it.

**2/**
The most you can lose is your stake.

No maintenance margin, no margin calls, no debt. A 10x position closes when the price moves 10% against you. A win pays up to +200% of the stake.

**3/**
Why Elysium:
· 100 ms blocks. Your fill comes from a block after your order lands, so nobody knows the price when you click.
· HYPE is gas, margin and payout.
· Launchpad coins get listed by public rules: pool age, market cap, volume, depth. More depth, more leverage.

**4/**
Next, when Elysium opens HyperCore to contracts: memes with a Hyperliquid perp get priced on-chain, from the order book.

Practice mode first: live prices, paper HYPE, no wallet. Real money after the audit.
