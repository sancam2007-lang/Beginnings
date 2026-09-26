# Beginnings Exchange

An economic emulator for the **Beginnings** campaign. It handles player accounts, multiple currencies, and (in later scripts) wallets, a goods shop, a bulk market, and a charter-company stock exchange. Time moves only when the GM advances it.

Runs on **Netlify** (site + serverless functions) with a **Neon** Postgres database. Both have free tiers.

---

## Build progress

| Script | Contents | Status |
|---|---|---|
| **1** | Accounts (username / roleplay name / password), sessions, GM console, join codes, multi-currency system | ✅ done |
| **2** | Wallets, GM clock + custom calendar, transfers, money-changer, treasury, transaction ledger with reversals | ✅ done |
| **3** | Markets, goods catalog, price engine on every advance, Goods Shop with charts, inventories | ✅ done |
| **4** | Settlements, stockpiles tied to a location, chartered companies with officers & treasuries, 1 Session = N days, seeded (replayable) advances, money-supply audit | ✅ done |
| **5** | Labor pools by skill tier × employment status, workplaces with staffing bands, hiring/releasing, GM-set standard wages, automatic wages on every advance | ✅ done |
| **6** | Resource nodes (finite reserves / renewables with yield), recipes, extraction & processing at workplaces with the handbook formula, day-by-day accrual to session totals | ✅ done |
| **7** | Construction by milestones of materials (blueprints → projects → finished workplace/warehouse), auto-supply, player-made goods NPCs never restock | ✅ done |
| **8** | Finite NPC purse per market, NPC demand per good, standing sell/buy orders filled while time passes, bulk Market with price slippage, market fee | ✅ done |
| **9** | ~~Routes, vessels, voyages, route events~~ replaced in 0.12.5 by simple shipping: stockpile → depot in another town in 5–10 days (sender picks), GM-set freight | ✅ reworked |
| **10** | The Exchange: company valuation (book value × bounded confidence), shares & order book between players and company treasuries, dividends, GM share register | ✅ done |
| **11** | A real supply chain: bulk markets become seller listings (no pricing algorithm, no restock), shopkeepers buy wholesale, raw goods only from resource nodes, goods types, auto-haul, NPC-run companies flag, old market stock sells out | ✅ done |
| **12** | NPC company automation: hire, buy inputs, list and reprice output, ship between towns; per-company behaviour; spreadsheet import of NPC companies | ✅ this version |
| 13 | Consumption & upkeep, supply-chain planner | next |
| 14 | Foreign trade (exports/imports), tariffs, GM events panel | |

The order follows the handbook-alignment review in `docs/`. The physical economy (workers, nodes, RU, recipes, stockpiles, construction, shipping) comes first, and it feeds an automated market whose NPC buyers have limited money.


---

## How it fits together

```
Browser (public/)            Netlify Functions (netlify/functions/)        Neon Postgres
 index.html  ─ sign in ───▶  /api/login, /api/register ──────────────────▶ users, sessions
 ledger.html ─ purse ─────▶  /api/wallet, /api/transfer, /api/exchange     wallets, transactions
 gm.html     ─ govern ────▶  /api/gm/clock, /api/gm/money, /api/gm/…       settings, time_advances, audit_log
```

- The **server decides everything** about money and permissions; the browser only displays.
- Tables are **created automatically** on the first request. You never need to run SQL by hand.
- Passwords are hashed with bcrypt. Sessions are HttpOnly cookies that last 30 days.
- No emails anywhere. If a player forgets their password, the GM resets it from the GM Console.

### Accounts
- **Username:** used only to sign in. 3–24 letters, numbers, or underscores. Other players never see it.
- **Roleplay name:** shown everywhere else. Must be unique. The GM can rename it.
- **The first account created becomes the GM.** After that, sign-up requires the **campaign join code** shown in the GM Console.
- 5 wrong passwords lock an account for 5 minutes. The GM can unlock it early.

### Currencies
- Default: **Crownsmark (₵)**, divided into **10 pence (p)**. Both the name and the ratio are editable.
- The GM can add any number of currencies, each with its own sub-unit and ratio.
- Every amount is stored as a whole number of the smallest unit, so there is no rounding drift.
- Each currency has an exchange rate against the **base** currency. Changing the base re-expresses every rate, so real values don't change.

### Money (script 2)
- Every account has a **purse** with a balance in each currency. Balances can never go below zero.
- **Every movement is a ledger entry**, stamped with the in-world date. Money only changes hands inside a database transaction, so a failed action never leaves money half-moved.
- **Players** can send money to anyone by roleplay name, and swap currencies at the **Money-Changer** at the GM's rates, minus an optional fee. Payouts round down so rounding can never create money.
- **The GM Treasury** can grant money (to one player or all players at once), seize it, or set a balance exactly. It shows every account's balances side by side, plus the full ledger. Any entry can be **reversed**. Both sides of an exchange reverse together.
- If the GM changes a currency's sub-units per unit (for example, 10 → 12 pence), every balance and past entry is **rescaled so its value stays the same**.

### Time (script 2)
- Time moves **only** when the GM clicks Advance (+1 day, +1 week, +1 month, or any number of days, with an optional note). Each advance is logged.
- The **calendar is yours**: a first year, an era suffix (e.g. "AC"), and 1–24 named months of any length. The default is 12 months of 30 days, starting in 1200 AC.
- **Set the Date** jumps straight to a date without running the simulation. Use it for corrections or to start the campaign on a specific day.
- `netlify/lib/tick.js` runs on every advance. Script 3 plugs market prices into it, and script 5 plugs in company values.

### Markets & goods (script 3)
- **Markets** are places, like "Grand Market" or "Port Varn Docks". Each one prices goods in **its own currency** and sets its shop terms: a markup when selling to players, and a buy-back % when buying from them. The first market, *Grand Market*, is created automatically in the base currency.
- The **goods catalog** lists everything that exists: a name, a unit ("sack", "coil"), a category, and whether it's sold in the Goods Shop or traded in bulk (bulk trading comes in script 4).
- A **listing** puts a good on sale at a market, with a normal price, current stock, normal stock, and restock per day.
- **Prices move every time the GM advances time.** Each simulated day:
  - `scarcity = normal stock ÷ stock` (goods in short supply get pricier)
  - `fair price = normal price × scarcity^sensitivity`
  - `price × (1 + pull × (fair ÷ price − 1) + event trend + random swing)`
  - Stock drifts back toward normal at the restock rate.

  Prices keep fractional sub-units, so small drifts add up. Long jumps (a whole year) are simulated day by day but charted as about 30 points.
- **GM levers** on every listing: daily swing %, pull-to-normal %, scarcity sensitivity, an **event trend** (e.g. +3%/day for 8 days during a blockade), and **Set price** for an instant change. Type `+20%` or `-15%` to shock a price.
- The **Goods Shop** lets players browse markets, see sparklines and full price charts (hover for exact values, or open the table view), and buy or sell. Buying draws down stock, which pushes the price up over the following days.
- **Inventories**: the Ledger shows each player's holdings and a goods log, and players can give items to one another. The GM can grant or seize items from the Treasury tab.
- If a market's currency changes, every price there is converted, so real values stay the same.
- **Bulk import** (GM → Markets → Bulk Import Goods): paste cells from Google Sheets or Excel (with the header row), or upload a CSV. Columns: `Name` (required), `Unit`, `Category`, `Description`, `Shop`, `Bulk`, `Market`, `Price`, `Stock`, `Normal stock`, `Restock`, `Swing %`, `Pull %`, `Scarcity`.
  - Headers are matched loosely: "Good Name" and "Restock/day" both work. Unrecognised columns are ignored.
  - **Price** is in whole units of that market's currency: `2.5` = 2 ₵ 5 p.
  - Repeat a good on several rows to list it at several markets.
  - Existing goods and listings are updated. Blank cells keep their current values, and the live price is never overwritten.
  - **Check** validates without saving. Any bad row stops the whole import and lists every problem by row number.
  - A template CSV can be downloaded from the panel.

### Places, stockpiles & companies (script 4)
- **Settlements** are the physical places: name, island, population, working-age share. Every market belongs to one. Existing markets were given a settlement of the same name automatically.
- **Goods always sit in a stockpile**, which has one owner and one place.
  - Each player has a **personal pack** that travels with the character, so it counts as being wherever they are.
  - **Warehouses, depots, and facility stores** belong to a player or company, are tied to a settlement, and can have a capacity in units.
  - Goods can only move between stockpiles in the **same settlement**. Moving them between towns will need shipping (script 9).
  - Script 3 inventories were converted into personal packs automatically.
- **Chartered companies**: a name, ticker, home port, charter terms, a treasury in every currency, and stockpiles. The GM appoints **directors and officers**. Both can pay from the treasury and move the company's goods. Anyone can pay money into a company.
- **Deleting listings** (GM → Markets → What's for Sale): delete one with its row's *Delete* button, or tick several (or the header box for all) and use *Delete selected*. The good comes off sale at that market, its price history is erased, and any open standing orders for it there are cancelled. The good stays in the catalog and in everyone's stockpiles, and can be listed again later.
- **Two separate kinds of market.** Every market is **either** a *bulk market* or a *goods shop* (GM → Markets → Type).
  - **Goods shops** serve players. They appear in the **Goods Shop** and use your own purse and your **personal pack only**, with the shop markup and buy-back.
  - **Bulk markets** serve **companies only**. They appear on the **bulk Market**; an officer trades from a company warehouse in that town, paid from the company treasury, with standing orders, the market fee and price impact.
  - A good is sold wherever it is listed, so list it at a shop, a bulk market, or both. The old per-good *Shop*/*Bulk* checkboxes are gone.
  - Turning a bulk market into a shop cancels its open standing orders. NPC traders along routes only move stock between bulk markets.
  - *Migration 11 made every existing market a bulk market, so the Goods Shop starts empty until the GM opens shops. (Migration 10 closed standing orders placed from players' own warehouses.)*
- **Sessions**: 1 Session = 90 days by default (3 of the default 30-day months). The GM can change this. The header shows "Session N, day D". Production will settle per session (script 6).
- **Replayable advances**: every advance stores a random seed. The same seed and the same starting data give the same prices.
- **Money audit**: the Time tab shows money in circulation, what's held by players and by companies, and how much was created or destroyed since the last advance, broken down by kind. Each advance's snapshot is kept in the time log, so inflation is easy to spot.

### Labor (script 5, per the handbook's Labor Rules)
- **Labor pools**: each settlement's Working Age population is split by skill tier (General 70% / Skilled 25% / Specialists 5%) and by status (Employed 75% / Available 10% / Unavailable 15%). Pools are built from population the first time they're needed, and rebuilt when the population changes. Workers on player payrolls always stay employed. Both splits are GM-editable defaults, and the GM can edit any count directly for migration, deaths, and so on. Counts can never go negative.
- **Hiring** moves workers Available → Employed within their own tier, drawing only on that settlement's pool. **Releasing** (or closing a workplace) moves them back. General workers can't fill Skilled or Specialist positions. Higher-skilled workers can fill lower positions and stay counted in their own tier (marked "over-qualified").
- **Workplaces** (GM-assigned for now; construction arrives in script 7) have a size class, with the handbook's typical workforce shown as guidance, and required General / Skilled / Specialist positions. **Output follows the staffing bands:** 100%+ → 100%, 75–99% → 75%, 50–74% → 50%, 25–49% → 25%, under 25% → cannot operate. Workers above a tier's requirement add nothing. Missing Skilled or Specialist workers cap output at their own band, so laborers can't stand in for an engineer. Script 6 uses this to scale production.
- **Wages**: the GM sets standard weekly wages per tier, realm-wide or per settlement. The handbook benchmark is General Labor at **8 CM/week**; **Skilled and Specialist have no default** and must be set by the GM or offered by the employer. Employers choose the wage when hiring and can change it later.
- **Paid automatically** from the owner's treasury on every advance. A full session costs weekly wage × **13 weeks** (GM setting), so a General worker costs exactly 104 CM per session. Fractions of a penny carry over. **If an employer can't pay**, it pays the workers it can afford and the rest quit, returning to the Available pool. Wages leave the economy (paid to NPCs) and show up in the Time tab's money report.

### Resources & production (script 6)
- **Resource nodes** (GM → Resources) are deposits or sources of one resource (a good, usually in RU) at a settlement, with **Quality** (Poor 0.75 / Normal 1 / Rich 1.25) and **Accessibility** (Easy 1.25 / Normal 1 / Difficult 0.75).
  - **Finite** nodes have a reserve that runs down to 0.
  - **Renewable** nodes can have a sustainable limit per session. Extracting above it lowers their yield (default −10% per session), and staying under it lets yield recover (default +5% per session).
  - Undiscovered nodes are hidden from players. Discovered ones appear under Known Resources on the Labor page.
- **Recipes** turn input RU into output RU per batch, with a qualitative "requirements" note (machinery, technology).
- **Production** happens at workplaces (GM → Labor → workplace form):
  - **Extraction** from a node in the same settlement: `Output per session = Base Output × Staffing × Quality × Accessibility` (× yield for renewables), capped by the remaining reserve.
  - **Processing** runs a recipe: `batches per session = Base Output × Staffing`, limited by the inputs actually in the workplace's stockpile. Inputs and outputs are exact integers, so nothing is created or lost.
  - Staffing uses script 5's bands, so understaffed sites (or sites missing a required Skilled/Specialist) produce less or nothing.
  - Everything goes into and comes out of the workplace's **linked stockpile**, and output stops when that stockpile is full.
  - **Timing:** output builds up day by day and whole RU are delivered as they complete. A full session gives exactly the session total, and fractions carry between advances. A blocked site (no inputs, full, exhausted) can't bank output.
  - Owners can pause or resume production. Each workplace shows expected output per session, what the last advance produced and consumed, and why it fell short.

### Construction & player-made goods (script 7)
- **Blueprints** (GM → Construction) define what can be built as a series of **milestones of materials**, e.g. *Foundations: 1,000 Stone* → *Frame & Roof: 1,000 Wood, 200 Planks*. A blueprint builds a **workplace** (size, required General/Skilled/Specialist workers, optional recipe and base batches, optional own store with capacity), a **warehouse/depot** (kind and capacity), or just a building.
- **Projects** (new Construction page): players start a project from a blueprint at a settlement, for themselves or a company they serve.
  - Materials are delivered from a stockpile in the **same settlement** or from a player's pack, and are **used up**. Anyone can contribute from their own stock.
  - Deliveries never take more than the current milestone still needs.
  - Milestones must be finished in order. After the last one, the building is created for the project's owner and appears on the Labor page, ready to staff.
  - **Auto-supply**: the owner can name a warehouse or depot in the same settlement, and every time the GM advances time, whatever the current milestone needs is fed in from it, milestone after milestone.
  - The owner can cancel a project (delivered materials aren't returned). The GM can complete a milestone or cancel any project.
- **Player-made goods**: tick *Player-made only* on a good (or use the `Player made` column in bulk import) and **NPC markets never restock it**. Its market stock only rises when players sell it in, and surplus above normal still drains away as NPCs buy it. Its price climbs from scarcity until players supply it. Use this for processed materials (planks, bricks, iron bars) while raw materials (logs, stone, ore) stay freely traded. The shop marks these goods *player-made*.

### NPC demand, standing orders & the bulk Market (script 8, reworked by script 11: see below)
- **The townsfolk's purse.** Each market can give its NPC buyers a **limited purse**: GM Console → Markets → edit market → *NPC buyers' purse*.
  - It refills by a set amount per session, spread over the days, up to a cap.
  - What players spend at that market (Goods Shop purchases, bulk buys, standing buy orders) flows back into it.
  - Everything NPCs pay players comes out of it: shop buy-back, bulk sales and standing sell orders. When the purse is empty, the townsfolk stop buying until it refills.
  - Markets in settlements with people start with 1 unit of currency per resident per session (cap: 3 sessions). A market in an empty settlement starts unlimited, as markets were before.
- **NPC demand.** Each listing has *NPC demand / day* (blank = same as restock), the amount the townsfolk buy each day.
  - Ordinary goods: NPC producers normally cover that demand, so the shelf only changes when players sell into it. Player sales pile up as surplus and the price falls.
  - Player-made goods: nobody else makes them. Demand that players don't meet empties the shelf and the price climbs.
- **Standing orders** (Market page), placed from a warehouse in the market's town and filled **day by day as the GM advances time**:
  - *Sell to townsfolk*: each day's NPC demand is met from players' asks first. Cheapest asks go first, and only asks at or below that day's market price fill, while the purse lasts and while the goods are actually in the warehouse.
  - *Buy from market*: takes goods off the shelf whenever price plus fee is at or below your limit, while funds and warehouse space last.
  - Nothing is reserved up front; goods and money are checked when an order fills. Orders can be cancelled by their owner or the GM, and the GM sees every open order under Markets.
- **Price charts**: each good on the bulk Market has a recent-price sparkline; click its name for the full price chart (with a table view), as in the Goods Shop.
- **Bulk trades** (Market page) work on every good listed at a bulk market.
  - A large order **walks the price**: each unit costs a little more (or fetches a little less) than the last, using the market's scarcity curve × the market's *bulk price impact*. The price is left where the trade ended.
  - The quote shows the average price, fee, total and price afterwards. If the market moved in the meantime, the trade is refused, never filled at a worse price.
- **Market fee** (default 2%): the Crown's cut of bulk trades and standing orders. It leaves circulation, so it shows in the money audit.
- The GM's time log reports units sold to and bought from NPCs, and each market's purse.

### Shipping between towns (script 9, reworked in 0.12.5)
The old modular system (routes, vessel classes, vessels, voyages, route events, hired carriers, NPC route traders) is gone. Now:
- **Send a shipment** (Shipping page) from one of your warehouses or depots, or your company's, to **any open depot in another town**. That can be your own, a company's, or another player's. The goods belong to whoever owns the destination once they arrive.
- **You choose the shipping time**, from 5 to 10 days (the GM can change the limits). The goods leave the source when you send them and arrive on the first advance that reaches the arrival day. Nothing is lost on the way.
- **Freight** is paid by the sender in the base currency, and the money leaves circulation:
  - Freight = GM rate per unit × units × (1 + rush % × days faster than the slowest). Rate and rush % are set in GM → Shipping; the defaults are free, and 10% per day faster.
  - Example: at ₵0.5 per unit and 10%, 200 units cost ₵100 in 10 days and ₵140 in 6 days.
- **Full or closed destination:** what doesn't fit **waits** there and is delivered at the next advance with room. The sender can **redirect** it to another depot in the same town.
- **GM → Shipping:**
  - The freight rules, with a worked example.
  - Every shipment, with **Deliver now**, **Send back** (the goods return to where they came from; freight isn't refunded) and **Redirect**.
- **NPC companies** ship goods that have no market in their town to one of their own depots in a town that trades them. They use their *Shipping time* setting (default 10 days, the cheapest).
- Goods on the way still count toward a company's book value, at the destination's prices.
- **What happened to the old data (migration 15).**
  - Cargo at sea or waiting at a dock became shipments with the same arrival day. Cargo whose owner had no stockpile at the destination shows as *waiting*, for the GM to redirect.
  - Routes, vessels, vessel classes, voyages, route events, vessel blueprints and vessel projects were deleted.

### The Exchange: shares, valuation & dividends (script 10)
- **Every company has shares.** A new charter comes with 1,000 (a GM setting), all held in the company's own **treasury** until sold. Existing companies were given theirs by migration 12.
- **Valuation**, in the base currency, refreshed every time the GM advances time:
  - **Book value** = treasury cash (all currencies, converted) + goods in company stockpiles (at local market prices) + goods it is shipping + *other assets* the GM sets (buildings, charters, monopolies).
  - **Confidence** is a bounded multiplier (default 0.5–2.0) that moves with book-value growth, dividends paid, and trades above or below the last price. It drifts back toward 1.0 over time.
  - **Price per share** = book value × confidence ÷ shares issued. Like the VOC: real assets underneath, sentiment on top, within limits.
- **Trading** (new Exchange page): post a limit order to buy or sell at your price.
  - A trade happens when a buyer's price meets a seller's, at the price of the order that was waiting, oldest first. You never trade with yourself.
  - Officers can trade **as their company's treasury**, for example selling treasury shares to raise capital or buying them back.
  - Money and shares aren't locked up, but you can't offer more than you have beyond your other open orders. An order whose owner can no longer honour it is cancelled when it would have traded.
- **Dividends**: a director pays a set amount per share from the treasury to every outside shareholder (treasury shares get nothing).
  - Dividends lift confidence at the next valuation.
  - They appear in each shareholder's ledger as *Dividend from …*.
- **GM → Exchange**:
  - revalue now
  - set a company's confidence or other assets
  - the share register: transfer shares with no money changing hands, issue new shares (dilutes everyone else), retire shares
  - the exchange rules: confidence bounds, weights, pull back to 1.0, and shares for a new charter

### A real supply chain (script 11): nothing appears from nowhere
- **Raw → processed → consumer.** Every good has a *Type* (GM → Markets → Goods, or a *Type* column in the import).
  - **Raw** materials only come out of **resource nodes**, extracted by a workplace. A node can only yield a raw good.
  - **Processed** goods (planks, bricks, iron) and **consumer** goods (chairs, cloth) are made from recipes in factories, and factories are built from blueprints.
- **Auto-haul** (Companies page → your company → each stockpile): pick another depot of the company in the same town. Each time the GM advances time, the goods move there. A workplace's own store only sends out what that workplace produces, so a factory keeps its inputs. Between towns, goods travel by ship or carrier.
- **Bulk markets are seller listings.** Nothing restocks by itself, and no pricing algorithm sets the price.
  - A company **lists** goods from its depot in the market's town at its own price per unit. The goods leave the depot and wait on the market floor. **Withdrawing** a listing returns what's unsold.
  - Buyers take the **cheapest listings first** and pay each listing's price. A company can also leave a **buy order** (a price it will pay). A new listing at or below a waiting buy order sells to it at once, at the buy order's price.
  - **Townsfolk** buy a set amount per day (GM: *Townsfolk buy / day*) from the cheapest listings at or below the most they'll pay, while the market's NPC purse lasts. Set it to 0 for raw materials people don't buy.
  - The **market price** is the last traded price, or the cheapest listing if nothing has traded. The sparkline and chart record it at each advance.
  - The **market fee** comes out of what the seller receives.
- **Goods shops are merchant-run.** The shopkeeper **buys wholesale** from bulk listings in the same town (same currency), up to *Buys wholesale / day*, until the shelf reaches its *Shelf target*.
  - The shopkeeper pays at most the shop's normal price, from the shop's purse.
  - Players buy from the shelf with their own purse. The shop's price follows how full its shelf is.
- **Old stock.** Migration 13 turned whatever sat on each bulk market's floor into an **"Old Stock of …" house**: an NPC company listing those goods at their last price. It sells out and never refills, which gives your producers time to start up. Goods-shop shelves stay as they were and are topped up only by wholesale buying from then on.
- **Company type** (GM → Companies → *Run by*): players or NPCs. NPC-run companies run themselves from script 12 (below). Old-stock houses aren't on the Exchange.
- NPC traders on routes now only move goods-shop stock between towns (existing stock, nothing created). Bulk-market goods belong to the companies that listed them.
- The GM can still grant goods and money. That's your deliberate hand, and it appears in the logs as a grant.

### NPC companies run themselves (script 12)
Any company whose **Run by** is NPCs now looks after itself every time the GM advances time. It only uses actions a player company has, so nothing is spawned.
- **Before production**
  - **Hire.** It fills each workplace's empty positions from the town's labor pool at the town's standard wage (GM → Labor). It hires only as many as it can pay for the *Keep for wages* period, which is never less than the advance itself. If the town has nobody left, or the treasury is thin, its log says so.
  - **Stock its factories.** A processing workplace needs its recipe inputs in its own store. The company first moves them from its other stockpiles in the same town. Then it buys the rest from the cheapest listings on that town's bulk market, never paying more than *Most it pays for inputs* (% of the listing's reference price) and never touching its wage money.
- **After production, hauling and arrivals**
  - **List.** Everything it holds that isn't one of its own inputs goes up for sale on a bulk market in the same town that trades that good. A new listing is priced at reference × (1 + *Markup*). More of the same good tops up its existing listing.
  - **Review prices** every *Review prices every* days (default 7, so advancing day by day doesn't crash prices). If nothing sold since the last review, the price drops by *Price step*. If more than half sold, it rises by the step. The price always stays between *Lowest* and *Highest* (% of reference).
  - **Ship.** Goods with no market in their town (a logging camp inland, say) are shipped (its *Shipping time*, default 10 days) to one of its depots in a town where a bulk market trades them. It waits for at least *Smallest shipment* units and only ships if it can pay the freight. The goods are listed there on the advance they arrive.
- **Behaviour.**
  - Every NPC company follows the defaults until you change them: on its profile (*NPC behaviour*), or for all of them at once (GM → **NPCs** → *Behaviour for every NPC company*).
  - Each part (hire, buy inputs, sell, ship) can be switched off. For example, turn off *Sell output* for a company you want to trade by hand.
- **GM → NPCs** lists every NPC company with its workplaces (staffing and what each made last advance), treasury, what it has on sale, and the actions it took last advance. Click a company to open its profile.
- **Import NPC companies** (GM → NPCs). Paste a sheet or upload a CSV, with one row per workplace. Columns:
  - *Company*, *Ticker*, *Town*, *Workplace*, *Mode* (extract/process), *Source* (node or recipe name), *Output*
  - *General*, *Skilled*, *Specialist*, *Size*, *Store capacity*, *Depot*, *Cash*

  Each workplace gets a "*Workplace* Store". A named depot is created in the same town and the store auto-hauls its outputs there. *Cash* is starting capital for new companies. *Check* validates everything first. Nothing is imported if any row has a problem, and workplaces that already exist are skipped, so the same sheet can be re-imported after you add rows. Goods, nodes and recipes must already exist.
- **Making it pay.** An NPC company lives or dies on its numbers. A workplace's wage bill per session (workers × weekly wage × weeks per session) has to be covered by what its output sells for. If it isn't, it runs down its cash, workers quit unpaid, and output falls. Tune *Output*, the listings' reference prices and town wages until the chain you want is profitable. Each company's log and the Exchange show you how it is doing.
- Time order of an advance: NPC hiring & buying → wages → construction supply → production → hauling → shipments arriving → NPC listing, repricing & shipping → NPC route traders → markets (townsfolk, shopkeepers) → valuation.
- Fixed: the *Import* buttons (goods and NPC companies) and a few confirm-then-act buttons lost track of the button after the confirmation box. Imports now work after confirming.
- API: `GET/POST /api/gm/npc` with `savePolicy { companyId, policy }`, `savePolicyAll { policy }` and `import { rows, dryRun? }`. `gm/profile` for an NPC company includes `npc { policy, defaults, last }`.

### Workplaces only come from construction (0.12.1)
- GM → Labor → **Set up a Workplace** no longer creates workplaces. You pick one that already exists (grouped *Built through construction* / *Placed by the GM*) and set its name, owner, size, positions, linked store, production and whether it's open. Its town is fixed, because a building stays where it was built.
- New workplaces come only from finished construction projects (a workplace blueprint), or from the NPC company import. The server refuses `saveWorkplace` without an `id`.
- The workplace table and the form show which project built each workplace and when it was finished.

### Buildings & Real Estate (0.12.6)
- **Every building is in one registry.** A building is one property: a **workplace** with its own store, a **storage** building (warehouse or depot), or a plain **building**. Each has an owner and a town.
- **Where buildings come from:**
  - Finished construction projects. Plain "building only" projects are now registered too.
  - Prebuilt Crown property you place.
  - The NPC company import.
  - Everything that existed before, registered by migration 16.
- **The Crown** owns property through **Crown Estates**, a company that isn't on the Exchange and has no officers. What the Crown is paid for sales and rent leaves circulation.
- **GM → Buildings:**
  - Every building, with its origin, workers, store and status.
  - **Manage** a building to rename it, give it a description, or **transfer** it to anyone.
  - **Place a Prebuilt Building:** a ready-made building from a blueprint, with no project or materials. It is Crown property by default.
- **GM → Real Estate:**
  - List any building for sale or for rent, as its owner.
  - See every listing (withdraw open ones) and every lease (end open ones).
- **Real Estate page (players):**
  - The market, where you **buy** or **rent** as yourself or as a company you serve.
  - **Your Property:** list a building for sale or for rent, or withdraw a listing.
  - **What You Rent:** move out of a lease.
- **Rules:**
  - **Workers stay** with a building when it changes hands; the new owner or tenant pays their wages.
  - A building's **store must be empty**, with no open market orders, to list it, sell it, lease it, or for a tenant to move out.
  - A **rented** building is run by the tenant, who gets its workplace and store. The owner keeps the title and gets rent.
  - **Rent** is per session, collected every advance pro rata, like wages. A lease can be open-ended or last a set number of sessions.
  - The tenant can leave any time with an empty store. The landlord can end an open-ended lease.
  - A lease also ends when the tenant can't pay, when its term runs out, or when the GM ends it. Anything left in the store then stays with the building, now the landlord's, and is logged as *left behind*.
  - A rented building can't be sold, listed or given away until the lease ends.
  - Changing a workplace's or storage's owner in GM → Labor or Companies moves the building's title with it.
- API: `GET/POST /api/realestate` and `GET/POST /api/gm/realestate`. See the table below.

### Stockpiles only come from construction too (0.12.4)
- Warehouses, depots and stores are **built**, never created from thin air. They come from a finished construction project (a stockpile blueprint, or a workplace blueprint's store), or from the NPC company import.
- **GM → Companies → Assign a Stockpile:** pick an existing stockpile (grouped *Built through construction* / *Workplace stores* / *Placed by the GM*) and set its owner, name, kind, capacity and whether it's open. Its town is fixed.
- **Profile panel (players and companies) → Assign a built stockpile:** hand this owner an existing stockpile. Only stockpiles that are empty, aren't a workplace's store and have no open market orders are offered.
- **Changing a stockpile's owner:**
  - It must be empty, because the goods belong to the current owner.
  - It must have no open listings or buy orders.
  - A workplace's store can't change owner on its own. Assign the **workplace** (Labor tab) and its empty store goes with it.
  - A workplace can't be linked to someone else's stockpile.
  - Auto-haul links that would cross owners are cleared.
- The stockpile table shows each stockpile's origin: which project built it, or which workplace it serves.
- API: `gm/companies saveStockpile` requires an `id`. `gm/profile` returns `assignable` stockpiles.

### A GM Console that can't go blank (0.12.2)
- Each GM tab now loads on its own. If a file is missing or out of date on the site (usually a partial upload to GitHub), only the affected tab stops working. A red banner at the top names the exact file(s) to re-upload. Before, one missing file blanked the whole console, top bar included. It also spots an out-of-date shared file (like `common.js`) and names it first, instead of listing every tab it breaks.

### Quality of life: profiles & account management (after script 11)
- **Profiles.** In the GM Console, click any player or company (Accounts, Companies, the Treasury balance table, stockpile owners) and its profile slides in from the right. Everything is managed in place, and the page refreshes behind it.
  - **Player profile:** roleplay name, username (what they sign in with), reset password (generates a readable temporary password to hand over, with a Copy button), make GM or player, disable or enable, unlock after failed sign-ins. Also: their companies (change role, ✕ remove, add to another company), money (grant or seize), goods, shares and recent activity.
  - **Company profile:** directors and officers (change role, ✕ remove, add a player), details (name, ticker, home port, run by, description, charter; dissolve or restore), treasury (grant or seize), stockpiles (add new ones, set auto-haul), workplaces, vessels, shareholders and recent activity.
  - Names inside a profile link onward: company → officer → their other companies. **Escape** or **Close** shuts it.
- **Accounts and Companies tabs** have search boxes, show everyone's companies as tags, and hide disabled accounts unless you ask. *+ Charter a company* opens a short form, and the new company's profile opens straight after so you can add officers.
- **Styled confirmation boxes** replace the browser's pop-up confirms and prompts everywhere.
- **Players' Ledger:** the Account panel shows your name, sign-in name and companies (linked), and asks for the new password twice. The Money-Changer is hidden while only one currency exists.
- API: `GET /api/gm/profile?type=user|company&id=`; `gm/users` gains `setUsername` and `resetPassword { generate: true }` (returns `tempPassword`).

---

## Setup (about 20 minutes, one time)

### 1. Put the code on GitHub
1. Sign in at <https://github.com> (create a free account if needed).
2. Click **+ → New repository**. Name it `beginnings-exchange`, set it to **Private**, and **don't** add a README. Click **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. Unzip `beginnings-exchange.zip` on your computer. Open the folder and drag **everything inside it** into the upload box, including the `netlify` and `public` folders. On a Mac, press **Cmd+Shift+.** to show the hidden `.gitignore` file, or just skip it.
5. Click **Commit changes**.

> Using git on the command line instead? The zip already contains a git history:
> ```
> cd beginnings-exchange
> git remote add origin https://github.com/YOUR-NAME/beginnings-exchange.git
> git push -u origin main
> ```

### 2. Create the database (Neon)
1. Sign up at <https://neon.tech>. You can sign in with GitHub.
2. Create a project named `beginnings`. Pick the region closest to you (e.g. US West).
3. On the project dashboard, click **Connect** and copy the **connection string**. It starts with `postgresql://` and ends with `?sslmode=require`. Keep it secret.

### 3. Deploy the site (Netlify)
1. Sign up at <https://netlify.com> with your GitHub account.
2. **Add new site → Import an existing project → GitHub**, then pick `beginnings-exchange`.
3. Leave the build settings as they are (`netlify.toml` handles them). Click **Deploy**.
4. Go to **Site configuration → Environment variables → Add a variable** and add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 2 |
   | `SETUP_KEY` | any secret phrase you choose. It protects the "create GM account" step so nobody else can claim GM first |

5. Go to **Deploys → Trigger deploy → Deploy site** so the variables take effect.
6. Optional: under **Domain management**, rename the site (e.g. `beginnings-exchange.netlify.app`).

### 4. Create your GM account
1. Open your site. It shows **First-time setup**.
2. Pick a username, roleplay name, and password, and enter your `SETUP_KEY`.
3. You land in the **GM Console**. Copy the **join code** and give it to your players.

### Updating to a new script
Upload or push the new files to the same GitHub repo. With the web uploader, drag the new versions of the `netlify` and `public` folders plus `package.json`, `package-lock.json`, and `netlify.toml`, and let them replace the old ones. Netlify redeploys automatically within a minute or two. Database tables upgrade themselves, and existing data is kept.

---

## Running it on your own computer (optional)
Requires Node 22+.
```
npm install
npm install -g netlify-cli
netlify link            # connect to your Netlify site (pulls env vars)
netlify dev             # opens http://localhost:8888
```

## API reference

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/status` | anyone | first-time-setup check |
| `POST /api/register` | anyone | `{ username, rpName, password, joinCode \| setupKey }` |
| `POST /api/login` | anyone | `{ username, password }` |
| `POST /api/logout` | signed in | end session |
| `GET /api/me` | anyone | current user or `null` |
| `POST /api/account` | signed in | `{ action:'changePassword', currentPassword, newPassword }` |
| `GET /api/currencies` | signed in | list currencies |
| `POST /api/currencies` | GM | create currency |
| `PUT /api/currencies` | GM | update / `setBase` / `setActive` |
| `GET/POST /api/gm/settings` | GM | join code, registration toggle, site name |
| `GET/POST /api/gm/users` | GM | accounts with their companies & balances · `rename` · `setUsername` · `resetPassword { newPassword } \| { generate: true }` · `setRole` · `setDisabled` · `unlock` |
| `GET /api/gm/profile?type=&id=` | GM | everything about one player or company (for the profile panel) |
| `GET/POST /api/gm/npc` | GM | NPC companies overview · `savePolicy { companyId, policy }` · `savePolicyAll { policy }` · `import { rows, dryRun? }` |
| `GET /api/clock` | signed in | current world date + calendar |
| `GET/POST /api/gm/clock` | GM | `advance {days, note}` · `setDate {year, month, day}` · `setCalendar {calendar}` |
| `GET /api/wallet?before=` | signed in | own balances + transaction history (paged) |
| `GET /api/players` | signed in | account directory by roleplay name |
| `POST /api/transfer` | signed in | `{ toUserId \| toCompanyId, currencyId, amount, memo }` |
| `POST /api/exchange` | signed in | `{ fromCurrencyId, toCurrencyId, amount }` |
| `GET/POST /api/gm/money` | GM | balances + ledger · `grant` · `seize` · `set` · `reverse` |
| `GET /api/markets?marketId=` | signed in | goods shops, one shop's goods, prices, sparklines, your holdings & purse there |
| `GET /api/price-history?marketId=&goodId=` | signed in | full price history of one good |
| `POST /api/shop` | signed in | `{ action: 'buy' \| 'sell', marketId, goodId, qty, stockpileId? }` (players only: always your personal pack) |
| `GET/POST /api/inventory` | signed in | your holdings + goods log · `give { toUserId, goodId, qty, memo }` |
| `GET/POST /api/bulk` | company officers, GM | a bulk market's goods, order book, trades, your depots & orders (`?marketId=`) · `quote` · `buy { goodId, qty, maxPrice, stockpileId, rest? }` · `list { goodId, qty, price, stockpileId }` · `cancelOrder` |
| `GET/POST /api/shipping` | signed in | your stockpiles, every depot you can ship to, your shipments, the rules · `quote { units, days }` · `send { fromStockpileId, toStockpileId, days, cargo }` · `redirect { shipmentId, stockpileId }` |
| `GET/POST /api/realestate` | signed in | market, your buildings & leases · `list { buildingId, kind: sale\|lease, price, currencyId?, termSessions?, note? }` · `cancel { listingId }` · `buy { listingId, as }` · `lease { listingId, as }` · `endLease { leaseId }` |
| `GET/POST /api/gm/realestate` | GM | every building, listing & lease · `place { blueprintId, settlementId, name, ownerType?, ownerId? }` · `transfer` · `rename` · `list` · `cancel` · `endLease` |
| `GET/POST /api/gm/transport` | GM | shipping rules & every shipment · `saveRules { ratePerUnit, rushPctPerDay, minDays, maxDays }` · `arriveNow` · `return` · `redirect { shipmentId, stockpileId }` |
| `GET/POST /api/shares` | signed in | the board, one company (`?companyId=`), your holdings & orders · `placeOrder { companyId, side, qty, price, as? }` · `cancelOrder` · `declareDividend { companyId, perShare }` (directors) |
| `GET/POST /api/gm/shares` | GM | `issue` · `retire` · `transfer` · `setValuation { companyId, confidence?, otherAssets? }` · `revalueAll` · `saveRules` |
| `GET/POST /api/gm/markets` | GM | `saveMarket` (incl. `kind: 'bulk' | 'shop'`, `feePct`, `bulkImpact`, `purseLimited`, `purseRefill`, `purseCap`, `purseNow`) · `saveGood` · `addListing` · `updateListing` · `setPrice` · `deleteListings { marketId, goodIds }` · `bulkImport { rows, dryRun? }` |
| `GET/POST /api/gm/items` | GM | stockpiles + goods log · `grant` / `seize { stockpileId, goodId, qty }` |
| `GET /api/world` | signed in | settlements and their markets |
| `GET /api/companies` | signed in | register of companies, members, your role |
| `GET/POST /api/company` | officers, GM | books (`?id=`): treasury, stockpiles, ledger, goods log · `pay { companyId, toType, toId, currencyId, amount }` · `setHaul { companyId, stockpileId, toStockpileId }` |
| `POST /api/stock-move` | signed in | `{ fromStockpileId, toStockpileId, goodId, qty }` (same settlement only) |
| `GET/POST /api/gm/world` | GM | `saveSettlement` |
| `GET/POST /api/gm/companies` | GM | `saveCompany` · `setMember` · `saveStockpile` |
| `GET/POST /api/labor` | signed in | labor market, known resources, your workplaces · `setProducing` · `hire { workplaceId, positionTier, workerTier?, count, weeklyWage, currencyId }` · `release { crewId, count }` · `setWage { crewId, weeklyWage }` |
| `GET/POST /api/gm/labor` | GM | `setDefaults` · `setWeeksPerSession` · `setRate` · `adjustPool` · `resetPool` · `saveWorkplace` (incl. `productionMode`, `nodeId`, `recipeId`, `baseOutput`) |
| `GET/POST /api/gm/resources` | GM | `saveNode` · `saveRecipe { inputs, outputs }` |
| `GET/POST /api/construction` | signed in | blueprints, projects · `start` · `deliver { projectId, stockpileId, goodId, qty }` · `setSupply` · `cancel` |
| `GET/POST /api/gm/construction` | GM | `saveBlueprint { milestones, resultType, resultSpec }` · `completeMilestone` · `cancel` |

All amounts in the API are **whole sub-units** (e.g. pence). `37` crownsmark-pence = 3 ₵ 7 p.

## Project layout
```
netlify.toml            Netlify build config
package.json            dependencies (Neon driver, bcryptjs, ws)
netlify/lib/            shared server code: db, schema/migrations, auth, validation,
                        ledger (money core), inventory (stockpiles & goods core),
                        market (shop price model), bulk-book (seller listings, buy orders,
                        townsfolk & shopkeepers), npc-market (purses, market tick), haul, transport (routes, voyages, events,
                        NPC traders), shares (valuation, order book, dividends), company, labor (pools, staffing, wages),
                        production (extraction & recipes), construction (milestones),
                        bulk-import, npc (NPC company automation), npc-import (NPC company sheets),
                        realestate (buildings registry, sales, leases, rent),
                        economy (money audit), rng (seeds),
                        calendar, tick (time hook)
docs/                   design notes and the handbook-alignment review
netlify/functions/      one file per API endpoint
public/                 the website: pages, css, js
public/js/gm/           one file per GM Console tab
```
