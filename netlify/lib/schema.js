// Database schema, applied automatically in order. Never edit a released
// migration — add a new array to the end instead (later scripts will).

export const MIGRATIONS = [
  // ── Migration 1 (script 1): settings, accounts, sessions, currencies, audit log
  [
    `create table if not exists settings (
       key        text primary key,
       value      jsonb not null,
       updated_at timestamptz not null default now()
     )`,

    `create table if not exists users (
       id            serial primary key,
       username      text not null,
       rp_name       text not null,
       password_hash text not null,
       role          text not null default 'player' check (role in ('gm', 'player')),
       disabled      boolean not null default false,
       failed_logins int not null default 0,
       locked_until  timestamptz,
       created_at    timestamptz not null default now(),
       last_login_at timestamptz
     )`,
    `create unique index if not exists users_username_key on users (lower(username))`,
    `create unique index if not exists users_rp_name_key on users (lower(rp_name))`,

    `create table if not exists sessions (
       token_hash text primary key,
       user_id    int not null references users(id) on delete cascade,
       created_at timestamptz not null default now(),
       expires_at timestamptz not null
     )`,
    `create index if not exists sessions_user_idx on sessions (user_id)`,

    // Amounts elsewhere are stored as whole sub-units (e.g. pence).
    // rate_to_base = value of ONE whole unit of this currency in whole base units.
    `create table if not exists currencies (
       id                serial primary key,
       code              text not null,
       name              text not null,
       symbol            text not null,
       subunit_name      text not null,
       subunit_symbol    text not null,
       subunits_per_unit int not null check (subunits_per_unit >= 1),
       rate_to_base      numeric(24, 10) not null check (rate_to_base > 0),
       is_base           boolean not null default false,
       active            boolean not null default true,
       sort_order        int not null default 0,
       created_at        timestamptz not null default now()
     )`,
    `create unique index if not exists currencies_code_key on currencies (lower(code))`,
    `create unique index if not exists currencies_one_base on currencies (is_base) where is_base`,

    `create table if not exists audit_log (
       id         bigserial primary key,
       actor_id   int references users(id) on delete set null,
       action     text not null,
       detail     jsonb,
       created_at timestamptz not null default now()
     )`,

    // Default currency: 1 crownsmark = 10 pence.
    `insert into currencies (code, name, symbol, subunit_name, subunit_symbol, subunits_per_unit, rate_to_base, is_base, sort_order)
     select 'CM', 'Crownsmark', '₵', 'pence', 'p', 10, 1, true, 0
     where not exists (select 1 from currencies)`,
  ],

  // ── Migration 2 (script 2): wallets, transactions, world clock
  [
    // One row per owner per currency. owner_type 'company' arrives in script 4.
    `create table if not exists wallets (
       owner_type    text not null check (owner_type in ('user', 'company')),
       owner_id      int not null,
       currency_id   int not null references currencies(id),
       balance_minor bigint not null default 0 check (balance_minor >= 0),
       primary key (owner_type, owner_id, currency_id)
     )`,

    // Every movement of money. A null "from" means minted by the Crown/GM;
    // a null "to" means removed from circulation. Multi-leg actions share a group_id.
    `create table if not exists transactions (
       id           bigserial primary key,
       group_id     text,
       created_at   timestamptz not null default now(),
       world_day    int not null,
       kind         text not null,
       from_type    text,
       from_id      int,
       to_type      text,
       to_id        int,
       currency_id  int not null references currencies(id),
       amount_minor bigint not null check (amount_minor > 0),
       memo         text,
       actor_id     int references users(id) on delete set null,
       reversal_of  bigint references transactions(id),
       reversed_by  bigint references transactions(id)
     )`,
    `create index if not exists transactions_from_idx on transactions (from_type, from_id, id desc)`,
    `create index if not exists transactions_to_idx on transactions (to_type, to_id, id desc)`,
    `create index if not exists transactions_group_idx on transactions (group_id) where group_id is not null`,

    `create table if not exists time_advances (
       id         serial primary key,
       from_day   int not null,
       to_day     int not null,
       kind       text not null default 'advance',
       note       text,
       actor_id   int references users(id) on delete set null,
       created_at timestamptz not null default now()
     )`,

    `insert into settings (key, value) values ('world_day', '0'::jsonb) on conflict (key) do nothing`,
    `insert into settings (key, value) values ('exchange_fee_pct', '0'::jsonb) on conflict (key) do nothing`,
    `insert into settings (key, value) values ('calendar', '{
       "epochYear": 1200, "era": "AC",
       "months": [
         {"name": "Frostmere", "days": 30}, {"name": "Thawing", "days": 30}, {"name": "Sowing", "days": 30},
         {"name": "Rains", "days": 30}, {"name": "Blossom", "days": 30}, {"name": "Midsummer", "days": 30},
         {"name": "Highsun", "days": 30}, {"name": "Harvest", "days": 30}, {"name": "Reaping", "days": 30},
         {"name": "Fallow", "days": 30}, {"name": "Mistfall", "days": 30}, {"name": "Longnight", "days": 30}
       ]
     }'::jsonb) on conflict (key) do nothing`,
  ],

  // ── Migration 3 (script 3): markets, goods, listings, price history, inventories
  [
    // A market is a place (a port, a city square). It prices everything in one currency.
    `create table if not exists markets (
       id          serial primary key,
       name        text not null,
       description text,
       currency_id int not null references currencies(id),
       markup_pct  numeric(6, 2) not null default 10,   -- shop sells to players at price + markup
       buyback_pct numeric(6, 2) not null default 80,   -- shop buys from players at this % of price
       active      boolean not null default true,
       sort_order  int not null default 0,
       created_at  timestamptz not null default now()
     )`,
    `create unique index if not exists markets_name_key on markets (lower(name))`,

    // The catalog of things that exist in the world.
    `create table if not exists goods (
       id          serial primary key,
       name        text not null,
       unit        text not null default 'each',
       category    text not null default 'General',
       description text,
       in_shop     boolean not null default true,    -- players can buy/sell in the Goods Shop
       in_bulk     boolean not null default false,   -- companies trade it in the bulk Market (script 4)
       active      boolean not null default true,
       created_at  timestamptz not null default now()
     )`,
    `create unique index if not exists goods_name_key on goods (lower(name))`,

    // A good for sale at a market, with its live price and supply model.
    // Prices are in the market currency's sub-units, kept with decimals so
    // small daily drifts accumulate; shoppers pay whole sub-units.
    `create table if not exists listings (
       market_id       int not null references markets(id) on delete cascade,
       good_id         int not null references goods(id) on delete cascade,
       base_price      numeric(20, 4) not null check (base_price > 0),
       price           numeric(20, 4) not null check (price > 0),
       prev_price      numeric(20, 4) not null,
       stock           bigint not null default 0 check (stock >= 0),
       target_stock    bigint not null default 100 check (target_stock >= 0),
       restock_per_day numeric(12, 3) not null default 5,
       volatility      numeric(6, 4) not null default 0.03,
       reversion       numeric(6, 4) not null default 0.05,
       elasticity      numeric(6, 4) not null default 0.5,
       trend           numeric(8, 5) not null default 0,
       trend_days      int not null default 0,
       active          boolean not null default true,
       primary key (market_id, good_id)
     )`,

    `create table if not exists price_history (
       id        bigserial primary key,
       market_id int not null,
       good_id   int not null,
       world_day int not null,
       price     numeric(20, 4) not null,
       stock     bigint not null
     )`,
    `create index if not exists price_history_idx on price_history (market_id, good_id, world_day)`,

    `create table if not exists inventories (
       owner_type text not null check (owner_type in ('user', 'company')),
       owner_id   int not null,
       good_id    int not null references goods(id),
       qty        bigint not null default 0 check (qty >= 0),
       primary key (owner_type, owner_id, good_id)
     )`,

    // Every movement of goods (purchases, sales, gifts, GM grants).
    `create table if not exists item_log (
       id          bigserial primary key,
       group_id    text,
       created_at  timestamptz not null default now(),
       world_day   int not null,
       kind        text not null,
       from_type   text,
       from_id     int,
       to_type     text,
       to_id       int,
       good_id     int not null references goods(id),
       qty         bigint not null check (qty > 0),
       market_id   int references markets(id) on delete set null,
       unit_price  bigint,
       currency_id int references currencies(id),
       memo        text,
       actor_id    int references users(id) on delete set null
     )`,
    `create index if not exists item_log_from_idx on item_log (from_type, from_id, id desc)`,
    `create index if not exists item_log_to_idx on item_log (to_type, to_id, id desc)`,

    // A first market, priced in the base currency.
    `insert into markets (name, description, currency_id)
     select 'Grand Market', 'The central market of the realm.', id from currencies where is_base
     and not exists (select 1 from markets)`,
  ],

  // ── Migration 4 (script 4): settlements, located stockpiles, companies, sessions, audit
  [
    // A settlement is a physical place: it has people, markets, stockpiles, and later nodes & facilities.
    `create table if not exists settlements (
       id              serial primary key,
       name            text not null,
       island          text,
       description     text,
       population      int not null default 0 check (population >= 0),
       working_age_pct numeric(5, 2) not null default 60,
       active          boolean not null default true,
       sort_order      int not null default 0,
       created_at      timestamptz not null default now()
     )`,
    `create unique index if not exists settlements_name_key on settlements (lower(name))`,
    `alter table markets add column if not exists settlement_id int references settlements(id)`,
    // Every existing market gets a settlement of the same name.
    `insert into settlements (name, description)
     select m.name, m.description from markets m
     where not exists (select 1 from settlements s where lower(s.name) = lower(m.name))`,
    `update markets m set settlement_id = s.id from settlements s
     where m.settlement_id is null and lower(s.name) = lower(m.name)`,

    `create table if not exists companies (
       id                 serial primary key,
       name               text not null,
       ticker             text not null,
       description        text,
       charter            text,
       home_settlement_id int references settlements(id),
       founded_day        int not null default 0,
       active             boolean not null default true,
       created_at         timestamptz not null default now()
     )`,
    `create unique index if not exists companies_name_key on companies (lower(name))`,
    `create unique index if not exists companies_ticker_key on companies (upper(ticker))`,

    `create table if not exists company_members (
       company_id int not null references companies(id) on delete cascade,
       user_id    int not null references users(id) on delete cascade,
       role       text not null check (role in ('director', 'officer')),
       since_day  int not null default 0,
       primary key (company_id, user_id)
     )`,

    // A stockpile is goods held by one owner at one place. A player's "personal"
    // stockpile has no settlement: it is what the character carries.
    `create table if not exists stockpiles (
       id            serial primary key,
       owner_type    text not null check (owner_type in ('user', 'company')),
       owner_id      int not null,
       settlement_id int references settlements(id),
       name          text not null,
       kind          text not null default 'warehouse'
                     check (kind in ('personal', 'warehouse', 'depot', 'facility', 'other')),
       capacity      bigint check (capacity is null or capacity >= 0),
       active        boolean not null default true,
       created_at    timestamptz not null default now(),
       check (kind = 'personal' or settlement_id is not null)
     )`,
    `create unique index if not exists stockpiles_personal_key on stockpiles (owner_type, owner_id) where kind = 'personal'`,
    `create index if not exists stockpiles_owner_idx on stockpiles (owner_type, owner_id)`,

    `create table if not exists stock (
       stockpile_id int not null references stockpiles(id) on delete cascade,
       good_id      int not null references goods(id),
       qty          bigint not null default 0 check (qty >= 0),
       primary key (stockpile_id, good_id)
     )`,

    // Move script-3 inventories into personal stockpiles, then retire the old table.
    `do $$ begin
       if to_regclass('inventories') is not null then
         insert into stockpiles (owner_type, owner_id, name, kind)
         select distinct i.owner_type, i.owner_id, 'Personal', 'personal' from inventories i
         on conflict (owner_type, owner_id) where kind = 'personal' do nothing;
         insert into stock (stockpile_id, good_id, qty)
         select s.id, i.good_id, i.qty from inventories i
         join stockpiles s on s.owner_type = i.owner_type and s.owner_id = i.owner_id and s.kind = 'personal'
         where i.qty > 0
         on conflict (stockpile_id, good_id) do update set qty = excluded.qty;
         drop table inventories;
       end if;
     end $$`,

    `alter table item_log add column if not exists from_stockpile_id int references stockpiles(id) on delete set null`,
    `alter table item_log add column if not exists to_stockpile_id int references stockpiles(id) on delete set null`,

    // Sessions, replayable advances, and the money-supply audit.
    `insert into settings (key, value) values ('session_days', '90'::jsonb) on conflict (key) do nothing`,
    `alter table time_advances add column if not exists seed text`,
    `alter table time_advances add column if not exists last_tx_id bigint`,
    `alter table time_advances add column if not exists money jsonb`,
  ],

  // ── Migration 5 (script 5): labor pools, wage rates, workplaces, employment
  [
    // Handbook defaults (GM-editable): Working Age split by status and by skill.
    `insert into settings (key, value) values ('labor_defaults', '{
       "status": {"employed": 75, "available": 10, "unavailable": 15},
       "tiers":  {"general": 70, "skilled": 25, "specialist": 5}
     }'::jsonb) on conflict (key) do nothing`,
    // 1 Session ≈ 13 weeks (handbook). Wages accrue so a full session costs exactly weekly × 13.
    `insert into settings (key, value) values ('weeks_per_session', '13'::jsonb) on conflict (key) do nothing`,

    // A settlement's Working Age population, per skill tier, by employment status.
    `create table if not exists labor_pools (
       settlement_id int not null references settlements(id) on delete cascade,
       tier          text not null check (tier in ('general', 'skilled', 'specialist')),
       employed      int not null default 0 check (employed >= 0),
       available     int not null default 0 check (available >= 0),
       unavailable   int not null default 0 check (unavailable >= 0),
       primary key (settlement_id, tier)
     )`,

    // Reference weekly wage per tier: global (settlement_id null) or a settlement override.
    `create table if not exists wage_rates (
       id                serial primary key,
       settlement_id     int references settlements(id) on delete cascade,
       tier              text not null check (tier in ('general', 'skilled', 'specialist')),
       weekly_wage_minor bigint not null check (weekly_wage_minor >= 0),
       currency_id       int not null references currencies(id)
     )`,
    `create unique index if not exists wage_rates_scope_key on wage_rates (coalesce(settlement_id, 0), tier)`,
    // Handbook benchmark: General Labor 8 CM/week. Skilled & Specialist are left for the GM to set.
    `insert into wage_rates (settlement_id, tier, weekly_wage_minor, currency_id)
     select null, 'general', 8 * c.subunits_per_unit, c.id from currencies c
     where not exists (select 1 from wage_rates where settlement_id is null and tier = 'general')
     order by (upper(c.code) = 'CM') desc, c.is_base desc limit 1`,

    // A place where people work (a workshop, mill, mine… facilities become production sites in script 6).
    `create table if not exists workplaces (
       id              serial primary key,
       owner_type      text not null check (owner_type in ('user', 'company')),
       owner_id        int not null,
       settlement_id   int not null references settlements(id),
       name            text not null,
       size            text not null default 'small_workshop',
       req_general     int not null default 0 check (req_general >= 0),
       req_skilled     int not null default 0 check (req_skilled >= 0),
       req_specialist  int not null default 0 check (req_specialist >= 0),
       stockpile_id    int references stockpiles(id) on delete set null,
       notes           text,
       active          boolean not null default true,
       created_at      timestamptz not null default now()
     )`,
    `create index if not exists workplaces_owner_idx on workplaces (owner_type, owner_id)`,

    // A crew: N workers of one skill tier filling positions of a (same or lower) tier at one wage.
    `create table if not exists employment (
       id                serial primary key,
       workplace_id      int not null references workplaces(id),
       position_tier     text not null check (position_tier in ('general', 'skilled', 'specialist')),
       worker_tier       text not null check (worker_tier in ('general', 'skilled', 'specialist')),
       count             int not null check (count > 0),
       weekly_wage_minor bigint not null check (weekly_wage_minor >= 0),
       currency_id       int not null references currencies(id),
       since_day         int not null default 0,
       unpaid_frac       numeric(20, 6) not null default 0
     )`,
    `create index if not exists employment_workplace_idx on employment (workplace_id)`,
  ],

  // ── Migration 6 (script 6): resource nodes, recipes, production at workplaces
  [
    // A deposit or renewable source of one resource (RU = a good) at a settlement.
    `create table if not exists resource_nodes (
       id                serial primary key,
       settlement_id     int not null references settlements(id),
       good_id           int not null references goods(id),
       name              text not null,
       kind              text not null default 'finite' check (kind in ('finite', 'renewable')),
       quality           text not null default 'normal' check (quality in ('poor', 'normal', 'rich')),
       accessibility     text not null default 'normal' check (accessibility in ('easy', 'normal', 'difficult')),
       original_reserve  bigint check (original_reserve is null or original_reserve >= 0),
       remaining_reserve bigint check (remaining_reserve is null or remaining_reserve >= 0),
       sustainable_limit numeric(14, 3),                 -- renewables: RU per session before overuse
       degrade_pct       numeric(6, 2) not null default 10, -- yield lost per session of overuse
       regen_pct         numeric(6, 2) not null default 5,  -- yield regained per session within the limit
       yield_factor      numeric(8, 5) not null default 1 check (yield_factor >= 0 and yield_factor <= 1),
       discovered        boolean not null default false,
       notes             text,
       active            boolean not null default true,
       created_at        timestamptz not null default now()
     )`,
    `create index if not exists resource_nodes_settlement_idx on resource_nodes (settlement_id)`,

    // A production line: input RU → output RU per batch.
    `create table if not exists recipes (
       id           serial primary key,
       name         text not null,
       description  text,
       requirements text,          -- qualitative: technology, machinery, facility needed
       active       boolean not null default true,
       created_at   timestamptz not null default now()
     )`,
    `create unique index if not exists recipes_name_key on recipes (lower(name))`,
    `create table if not exists recipe_items (
       recipe_id int not null references recipes(id) on delete cascade,
       good_id   int not null references goods(id),
       role      text not null check (role in ('in', 'out')),
       qty       int not null check (qty > 0),
       primary key (recipe_id, good_id, role)
     )`,

    // What a workplace produces. Extraction draws from a node; processing runs a recipe.
    // Inputs and outputs live in the workplace's linked stockpile (no teleporting).
    `alter table workplaces add column if not exists production_mode text not null default 'none'`,
    `alter table workplaces add column if not exists node_id int references resource_nodes(id) on delete set null`,
    `alter table workplaces add column if not exists recipe_id int references recipes(id) on delete set null`,
    `alter table workplaces add column if not exists base_output numeric(14, 3) not null default 0`,
    `alter table workplaces add column if not exists producing boolean not null default true`,
    `alter table workplaces add column if not exists progress numeric(20, 6) not null default 0`,
    `alter table workplaces add column if not exists last_output jsonb`,
    `do $$ begin
       if not exists (select 1 from pg_constraint where conname = 'workplaces_production_mode_check') then
         alter table workplaces add constraint workplaces_production_mode_check
           check (production_mode in ('none', 'extract', 'process'));
       end if;
     end $$`,
  ],

  // ── Migration 7 (script 7): construction by material milestones; player-made goods
  [
    // false = NPCs never restock this good in markets; only players can make it (processed goods).
    `alter table goods add column if not exists npc_supply boolean not null default true`,

    // A building type players can start. milestones = [{ name, materials: [{ goodId, qty }] }]
    // result_spec describes what gets built (a workplace and/or a stockpile).
    `create table if not exists blueprints (
       id          serial primary key,
       name        text not null,
       description text,
       result_type text not null default 'none' check (result_type in ('workplace', 'stockpile', 'none')),
       result_spec jsonb not null default '{}'::jsonb,
       milestones  jsonb not null default '[]'::jsonb,
       active      boolean not null default true,
       created_at  timestamptz not null default now()
     )`,
    `create unique index if not exists blueprints_name_key on blueprints (lower(name))`,

    // A building under way. Milestones are copied from the blueprint when it starts, with a
    // 'delivered' count per material, so later blueprint edits never change a running project.
    `create table if not exists construction_projects (
       id                  serial primary key,
       blueprint_id        int references blueprints(id) on delete set null,
       name                text not null,
       owner_type          text not null check (owner_type in ('user', 'company')),
       owner_id            int not null,
       settlement_id       int not null references settlements(id),
       result_type         text not null,
       result_spec         jsonb not null default '{}'::jsonb,
       milestones          jsonb not null,
       current             int not null default 0,
       status              text not null default 'active' check (status in ('active', 'complete', 'cancelled')),
       supply_stockpile_id int references stockpiles(id) on delete set null,
       started_day         int not null default 0,
       completed_day       int,
       result_ref          jsonb,
       created_by          int references users(id) on delete set null,
       created_at          timestamptz not null default now()
     )`,
    `create index if not exists construction_projects_status_idx on construction_projects (status, settlement_id)`,
    `alter table item_log add column if not exists project_id int references construction_projects(id) on delete set null`,
  ],

  // ── Migration 8 (script 8): NPC purse, NPC demand, standing orders, bulk trading
  [
    // Each market's NPC buyers share a finite PURSE (market currency, sub-units). It refills each
    // session and is topped up by what players spend there, so NPC buying power is bounded.
    // npc_purse null = unlimited (the pre-script-8 behaviour).
    `alter table markets add column if not exists fee_pct numeric(6, 2) not null default 2`,
    `alter table markets add column if not exists bulk_impact numeric(6, 3) not null default 0.5`,
    `alter table markets add column if not exists npc_purse bigint`,
    `alter table markets add column if not exists purse_refill bigint not null default 0`,
    `alter table markets add column if not exists purse_cap bigint`,
    // Starting point for markets in a populated settlement: 1 whole unit of currency per resident
    // per session, capped at 3 sessions' worth. Empty settlements stay unlimited until the GM sets one.
    `update markets m set purse_refill = s.population * c.subunits_per_unit,
                          npc_purse = s.population * c.subunits_per_unit,
                          purse_cap = 3 * s.population * c.subunits_per_unit
     from settlements s, currencies c
     where s.id = m.settlement_id and c.id = m.currency_id and s.population > 0 and m.npc_purse is null`,

    // NPC consumption of a good at a market, units per day (null = same as restock per day).
    `alter table listings add column if not exists npc_demand numeric(12, 3)`,

    // Standing orders against a market's NPCs.
    //   sell: offer goods from a stockpile in the market's settlement to NPC buyers at an asking price
    //   buy:  buy from the market's stock whenever the price is at or below a limit
    `create table if not exists market_orders (
       id           serial primary key,
       market_id    int not null references markets(id) on delete cascade,
       good_id      int not null references goods(id),
       side         text not null check (side in ('sell', 'buy')),
       owner_type   text not null check (owner_type in ('user', 'company')),
       owner_id     int not null,
       stockpile_id int not null references stockpiles(id) on delete cascade,
       qty_total    bigint not null check (qty_total > 0),
       qty_left     bigint not null check (qty_left >= 0),
       limit_price  numeric(20, 4) not null check (limit_price > 0),
       status       text not null default 'active' check (status in ('active', 'filled', 'cancelled')),
       created_day  int not null default 0,
       created_by   int references users(id) on delete set null,
       last_fill    jsonb,
       created_at   timestamptz not null default now()
     )`,
    `create index if not exists market_orders_active_idx on market_orders (market_id, good_id, side) where status = 'active'`,
  ],

  // ── Migration 9 (script 9): routes, vessels, voyages, route events, NPC trade between markets
  [
    // A route joins two settlements (both directions). mode: sea / river / land — vessels must match.
    `create table if not exists routes (
       id                  serial primary key,
       name                text not null,
       from_settlement_id  int not null references settlements(id) on delete cascade,
       to_settlement_id    int not null references settlements(id) on delete cascade,
       mode                text not null default 'sea' check (mode in ('sea', 'river', 'land')),
       days                int not null default 7 check (days between 1 and 3650),
       risk_pct            numeric(6, 2) not null default 10 check (risk_pct >= 0 and risk_pct <= 100),
       freight_minor       numeric(20, 4) not null default 0 check (freight_minor >= 0),
       currency_id         int references currencies(id),
       npc_trade_per_day   numeric(12, 2) not null default 0 check (npc_trade_per_day >= 0),
       notes               text,
       active              boolean not null default true,
       created_at          timestamptz not null default now(),
       check (from_settlement_id <> to_settlement_id)
     )`,
    `create unique index if not exists routes_pair_mode_key on routes
       (least(from_settlement_id, to_settlement_id), greatest(from_settlement_id, to_settlement_id), mode)`,

    // Classes of vessel the GM defines: a cog, a galleon, an ox-wagon, a river barge…
    `create table if not exists vessel_types (
       id          serial primary key,
       name        text not null unique,
       mode        text not null default 'sea' check (mode in ('sea', 'river', 'land')),
       capacity    bigint not null default 500 check (capacity >= 0),
       speed       numeric(6, 3) not null default 1 check (speed > 0),
       description text,
       active      boolean not null default true
     )`,

    // One vessel. settlement_id = where it is docked (null while under way or lost).
    `create table if not exists vessels (
       id            serial primary key,
       owner_type    text not null check (owner_type in ('user', 'company')),
       owner_id      int not null,
       type_id       int not null references vessel_types(id),
       name          text not null,
       settlement_id int references settlements(id) on delete set null,
       status        text not null default 'docked' check (status in ('docked', 'voyage', 'lost')),
       created_at    timestamptz not null default now()
     )`,
    `create index if not exists vessels_owner_idx on vessels (owner_type, owner_id)`,

    // A voyage: an owned vessel sailing a route, or goods sent with hired NPC carriers (vessel_id null).
    // Cargo in transit sits in voyage_cargo — it has left every stockpile until it is unloaded.
    `create table if not exists voyages (
       id                   serial primary key,
       vessel_id            int references vessels(id) on delete set null,
       route_id             int not null references routes(id),
       owner_type           text not null check (owner_type in ('user', 'company')),
       owner_id             int not null,
       from_settlement_id   int not null references settlements(id),
       to_settlement_id     int not null references settlements(id),
       depart_day           int not null,
       travel_days          int not null default 1,
       arrive_day           int not null,
       arrived_day          int,
       deliver_to_id        int references stockpiles(id) on delete set null,
       status               text not null default 'underway' check (status in ('underway', 'arrived', 'complete', 'lost')),
       events               jsonb not null default '[]'::jsonb,
       freight_paid         bigint not null default 0,
       freight_currency_id  int references currencies(id),
       started_by           int references users(id) on delete set null,
       created_at           timestamptz not null default now()
     )`,
    `create index if not exists voyages_status_idx on voyages (status)`,
    `create table if not exists voyage_cargo (
       voyage_id int not null references voyages(id) on delete cascade,
       good_id   int not null references goods(id),
       loaded    bigint not null default 0 check (loaded >= 0),
       qty       bigint not null check (qty >= 0),
       lost      bigint not null default 0 check (lost >= 0),
       primary key (voyage_id, good_id)
     )`,
    `alter table item_log add column if not exists voyage_id int references voyages(id) on delete set null`,

    // What can happen at sea/on the road. Chance per voyage = the route's risk %.
    `insert into settings (key, value) values ('route_events', '[
       {"key":"storm","label":"Storm","weight":45,"delayMin":1,"delayMax":4},
       {"key":"fair_winds","label":"Fair winds","weight":20,"delayMin":-2,"delayMax":-1},
       {"key":"raiders","label":"Pirates / bandits","weight":25,"lossMin":10,"lossMax":40},
       {"key":"wreck","label":"Shipwreck / ambush","weight":10,"lost":true}
     ]'::jsonb) on conflict (key) do nothing`,

    // Shipyards: a blueprint can now build a vessel.
    `do $$ declare c record; begin
       for c in select conname from pg_constraint
                where conrelid = 'blueprints'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%result_type%'
       loop execute format('alter table blueprints drop constraint %I', c.conname); end loop;
     end $$`,
    `alter table blueprints add constraint blueprints_result_type_ck check (result_type in ('workplace', 'stockpile', 'vessel', 'none'))`,
  ],

  // ── Migration 10: the Goods Shop is for players, the bulk Market for companies.
  // Standing orders placed from a player's own warehouse are closed.
  [
    `update market_orders set status = 'cancelled' where owner_type = 'user' and status = 'active'`,
  ],

  // ── Migration 11: every market is EITHER a bulk market (companies) or a goods shop (players).
  // All existing markets become bulk markets; the Goods Shop starts empty until the GM opens shops.
  // Where a good is sold is now decided by the market's kind, not by the good's old shop/bulk flags.
  [
    `alter table markets add column if not exists kind text not null default 'bulk' check (kind in ('bulk', 'shop'))`,
  ],

  // ── Migration 12 (script 10): company valuation, shares, the Exchange, dividends
  [
    // Valuation: price per share = book value × confidence ÷ shares issued (in base-currency sub-units).
    `alter table companies add column if not exists shares_total bigint not null default 0 check (shares_total >= 0)`,
    `alter table companies add column if not exists confidence numeric(8, 4) not null default 1`,
    `alter table companies add column if not exists other_assets bigint not null default 0`,
    `alter table companies add column if not exists book_value bigint`,
    `alter table companies add column if not exists share_price numeric(20, 4)`,
    `alter table companies add column if not exists valued_day int`,
    `alter table vessel_types add column if not exists value_minor bigint not null default 0 check (value_minor >= 0)`,

    // Who owns shares. A company holding ITS OWN shares = treasury (unsold) shares.
    `create table if not exists shareholdings (
       company_id int not null references companies(id) on delete cascade,
       owner_type text not null check (owner_type in ('user', 'company')),
       owner_id   int not null,
       qty        bigint not null default 0 check (qty >= 0),
       primary key (company_id, owner_type, owner_id)
     )`,

    // The order book between players (and companies trading for their treasury). Limit orders only.
    `create table if not exists share_orders (
       id          serial primary key,
       company_id  int not null references companies(id) on delete cascade,
       side        text not null check (side in ('buy', 'sell')),
       owner_type  text not null check (owner_type in ('user', 'company')),
       owner_id    int not null,
       qty_total   bigint not null check (qty_total > 0),
       qty_left    bigint not null check (qty_left >= 0),
       price       bigint not null check (price > 0),
       status      text not null default 'active' check (status in ('active', 'filled', 'cancelled')),
       created_day int not null default 0,
       created_by  int references users(id) on delete set null,
       created_at  timestamptz not null default now()
     )`,
    `create index if not exists share_orders_book_idx on share_orders (company_id, side, price) where status = 'active'`,
    `create table if not exists share_trades (
       id          bigserial primary key,
       company_id  int not null references companies(id) on delete cascade,
       buyer_type  text not null, buyer_id int not null,
       seller_type text not null, seller_id int not null,
       qty         bigint not null check (qty > 0),
       price       bigint not null check (price > 0),
       world_day   int not null,
       created_at  timestamptz not null default now()
     )`,
    `create index if not exists share_trades_company_idx on share_trades (company_id, id desc)`,
    `create table if not exists valuations (
       id          bigserial primary key,
       company_id  int not null references companies(id) on delete cascade,
       world_day   int not null,
       book_value  bigint not null,
       confidence  numeric(8, 4) not null,
       share_price numeric(20, 4),
       detail      jsonb
     )`,
    `create index if not exists valuations_company_idx on valuations (company_id, world_day)`,
    `create table if not exists dividends (
       id           serial primary key,
       company_id   int not null references companies(id) on delete cascade,
       world_day    int not null,
       per_share    bigint not null check (per_share > 0),
       shares_paid  bigint not null,
       total        bigint not null,
       currency_id  int not null references currencies(id),
       declared_by  int references users(id) on delete set null,
       created_at   timestamptz not null default now()
     )`,

    // Every existing company is chartered with 1,000 shares, all held in its own treasury until sold.
    `update companies set shares_total = 1000 where shares_total = 0`,
    `insert into shareholdings (company_id, owner_type, owner_id, qty)
     select id, 'company', id, shares_total from companies on conflict do nothing`,
    `insert into settings (key, value) values ('exchange_rules', '{"minConfidence":0.5,"maxConfidence":2,"growthWeight":0.5,"dividendWeight":1,"tradeWeight":0.3,"reversionPerSession":0.25,"newCompanyShares":1000}'::jsonb)
     on conflict (key) do nothing`,
  ],

  // ── Migration 13 (script 11): a real supply chain — nothing appears from nowhere.
  //   • Bulk markets become an order book of SELLER LISTINGS: goods are escrowed out of a company's
  //     depot and sold at the seller's price. No pricing algorithm, no restock.
  //   • Goods shops are merchant-run: the shopkeeper buys wholesale from bulk listings in town.
  //   • Old market floors become a one-time "Old Stock" house that sells out and never refills.
  [
    `alter table companies add column if not exists kind text not null default 'player' check (kind in ('player', 'npc', 'house'))`,
    `alter table companies add column if not exists house_market_id int references markets(id) on delete set null`,
    `alter table goods add column if not exists kind text not null default 'raw' check (kind in ('raw', 'processed', 'consumer'))`,
    `update goods set kind = case when npc_supply then 'raw' else 'processed' end`,
    // Auto-haul: each time the GM advances time, everything in this stockpile moves to another in the same town.
    `alter table stockpiles add column if not exists haul_to_id int references stockpiles(id) on delete set null`,
    // Every bulk-market trade, for prices and charts. buyer_kind: company | townsfolk | shop.
    `create table if not exists market_trades (
       id           bigserial primary key,
       market_id    int not null references markets(id) on delete cascade,
       good_id      int not null references goods(id),
       qty          bigint not null check (qty > 0),
       price        numeric(20, 4) not null,
       buyer_kind   text not null,
       buyer_type   text, buyer_id int,
       seller_type  text not null, seller_id int not null,
       shop_market_id int references markets(id) on delete set null,
       world_day    int not null,
       created_at   timestamptz not null default now()
     )`,
    `create index if not exists market_trades_idx on market_trades (market_id, good_id, id desc)`,
    // Sell orders now hold their goods (escrow) — old unescrowed sell orders are closed.
    `update market_orders set status = 'cancelled' where side = 'sell' and status = 'active'`,
    // Bulk-market townsfolk demand: keep what they had (it used to default to the restock rate).
    `update listings l set npc_demand = l.restock_per_day from markets m
     where m.id = l.market_id and m.kind = 'bulk' and l.npc_demand is null`,
    // Old bulk-market floors → an "Old Stock" house per market, selling what was there at the last price.
    `do $$ declare m record; l record; cid int; pid int; d int; begin
       select coalesce((value)::text::int, 0) into d from settings where key = 'world_day';
       for m in select mk.* from markets mk where mk.kind = 'bulk' and mk.settlement_id is not null
                  and exists (select 1 from listings where market_id = mk.id and stock > 0) loop
         insert into companies (name, ticker, description, home_settlement_id, kind, house_market_id, active, founded_day)
         values ('Old Stock of ' || m.name, 'OLD' || m.id,
                 'The goods left on ' || m.name || '''s floor when it became a market of seller listings. Sells out; never refills.',
                 m.settlement_id, 'house', m.id, true, coalesce(d, 0))
         returning id into cid;
         insert into stockpiles (owner_type, owner_id, settlement_id, name, kind)
         values ('company', cid, m.settlement_id, 'Old stock', 'warehouse') returning id into pid;
         for l in select * from listings where market_id = m.id and stock > 0 loop
           insert into market_orders (market_id, good_id, side, owner_type, owner_id, stockpile_id, qty_total, qty_left, limit_price, created_day)
           values (m.id, l.good_id, 'sell', 'company', cid, pid, l.stock, l.stock, greatest(1, ceil(l.price)), coalesce(d, 0));
         end loop;
       end loop;
     end $$`,
    // On a bulk market, "stock" now means what sellers have listed.
    `update listings l set stock = coalesce((select sum(o.qty_left) from market_orders o
        where o.market_id = l.market_id and o.good_id = l.good_id and o.side = 'sell' and o.status = 'active'), 0)
     from markets m where m.id = l.market_id and m.kind = 'bulk'`,
  ],

  // ── Migration 14 (script 12): NPC companies run themselves.
  //   npc_policy: how an NPC-run company behaves (see lib/npc.js for the defaults).
  //   npc_last:   what it did at the last time advance, shown to the GM.
  [
    `alter table companies add column if not exists npc_policy jsonb not null default '{}'::jsonb`,
    `alter table companies add column if not exists npc_last jsonb`,
    // When an NPC seller last reviewed this listing's price (null = never; counts from created_day).
    `alter table market_orders add column if not exists repriced_day int`,
  ],
  // ── Migration 15: shipping is no longer routes + vessels. Goods go from a stockpile to a depot in
  // another town in 5–10 days (the sender's choice), for a GM-set freight fee.
  // Cargo still at sea is turned into shipments (delivered on the next advance that reaches its arrival
  // day), then routes, vessels, vessel classes, voyages and vessel blueprints are deleted.
  [
    `create table if not exists shipments (
       id                 serial primary key,
       owner_type         text not null check (owner_type in ('user', 'company')),
       owner_id           int not null,
       from_stockpile_id  int references stockpiles(id) on delete set null,
       to_stockpile_id    int references stockpiles(id) on delete set null,
       from_settlement_id int not null references settlements(id),
       to_settlement_id   int not null references settlements(id),
       depart_day         int not null,
       days               int not null check (days >= 0),
       arrive_day         int not null,
       delivered_day      int,
       status             text not null default 'transit' check (status in ('transit', 'waiting', 'delivered', 'returned')),
       fee_minor          bigint not null default 0,
       fee_currency_id    int references currencies(id),
       note               text,
       created_by         int references users(id) on delete set null,
       created_at         timestamptz not null default now()
     )`,
    `create index if not exists shipments_status_idx on shipments (status, arrive_day)`,
    `create index if not exists shipments_owner_idx on shipments (owner_type, owner_id)`,
    `create table if not exists shipment_cargo (
       shipment_id int not null references shipments(id) on delete cascade,
       good_id     int not null references goods(id),
       loaded      bigint not null check (loaded >= 0),
       qty         bigint not null check (qty >= 0),
       primary key (shipment_id, good_id)
     )`,
    `alter table item_log add column if not exists shipment_id int references shipments(id) on delete set null`,

    // Cargo at sea or waiting in port → shipments to the voyage's depot (or any of the owner's stockpiles there).
    `do $$ declare v record; dest int; sid int; today int; begin
       if to_regclass('voyages') is null then return; end if;
       select coalesce((select (value #>> '{}')::int from settings where key = 'world_day'), 0) into today;
       for v in select * from voyages where status in ('underway', 'arrived')
                  and exists (select 1 from voyage_cargo c where c.voyage_id = voyages.id and c.qty > 0) loop
         select s.id into dest from stockpiles s where s.id = v.deliver_to_id and s.active and s.settlement_id = v.to_settlement_id;
         if dest is null then
           select s.id into dest from stockpiles s where s.owner_type = v.owner_type and s.owner_id = v.owner_id
             and s.settlement_id = v.to_settlement_id and s.active and s.kind <> 'personal' order by s.id limit 1;
         end if;
         insert into shipments (owner_type, owner_id, to_stockpile_id, from_settlement_id, to_settlement_id,
                                depart_day, days, arrive_day, status, note)
         values (v.owner_type, v.owner_id, dest, v.from_settlement_id, v.to_settlement_id, v.depart_day,
                 greatest(0, v.arrive_day - v.depart_day), case when v.status = 'arrived' then today else v.arrive_day end,
                 case when dest is null then 'waiting' else 'transit' end,
                 'Cargo from a voyage under the old shipping system'
                   || case when dest is null then ' — no stockpile of the owner at the destination; the GM can redirect it' else '' end)
         returning id into sid;
         insert into shipment_cargo (shipment_id, good_id, loaded, qty)
         select sid, c.good_id, c.qty, c.qty from voyage_cargo c where c.voyage_id = v.id and c.qty > 0;
         dest := null;
       end loop;
     end $$`,

    `alter table item_log drop column if exists voyage_id`,
    `drop table if exists voyage_cargo`,
    `drop table if exists voyages`,
    `drop table if exists vessels`,
    `drop table if exists vessel_types`,
    `drop table if exists routes`,
    `delete from settings where key = 'route_events'`,
    // Shipyards go too: vessel blueprints and their projects (delivered materials are gone, as with any cancelled project).
    `delete from construction_projects where result_type = 'vessel'`,
    `delete from blueprints where result_type = 'vessel'`,
    `do $$ declare c record; begin
       for c in select conname from pg_constraint
                where conrelid = 'blueprints'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%result_type%'
       loop execute format('alter table blueprints drop constraint %I', c.conname); end loop;
     end $$`,
    `alter table blueprints add constraint blueprints_result_type_ck check (result_type in ('workplace', 'stockpile', 'none'))`,

    // Freight: rate per unit for the slowest shipment (base currency sub-units), + rush % per day faster.
    `insert into settings (key, value) values ('shipping', '{"ratePerUnit":0,"rushPctPerDay":10,"minDays":5,"maxDays":10}'::jsonb)
     on conflict (key) do nothing`,
  ],
  // ── Migration 16: buildings registry, real estate (sales and leases), Crown property.
  //   A BUILDING is one property on the map: a workplace (with its store), a storage building
  //   (warehouse/depot), or a plain building. It has an owner (title). While leased, the tenant
  //   operates its workplace and store; the owner keeps the title and collects rent.
  //   Crown property is owned by the "Crown Estates" company (kind 'crown'); what it earns leaves circulation.
  [
    `do $$ declare c record; begin
       for c in select conname from pg_constraint
                where conrelid = 'companies'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'
       loop execute format('alter table companies drop constraint %I', c.conname); end loop;
     end $$`,
    `alter table companies add constraint companies_kind_ck check (kind in ('player', 'npc', 'house', 'crown'))`,
    `insert into companies (name, ticker, description, kind, active, founded_day, shares_total)
     select 'Crown Estates', 'CROWN', 'Property of the Crown: buildings the GM places, sells and leases.', 'crown', true,
            coalesce((select (value #>> '{}')::int from settings where key = 'world_day'), 0), 0
     where not exists (select 1 from companies where kind = 'crown')
     on conflict do nothing`,

    `create table if not exists buildings (
       id            serial primary key,
       name          text not null,
       kind          text not null check (kind in ('workplace', 'storage', 'building')),
       settlement_id int not null references settlements(id),
       owner_type    text not null check (owner_type in ('user', 'company')),
       owner_id      int not null,
       workplace_id  int unique references workplaces(id) on delete set null,
       stockpile_id  int unique references stockpiles(id) on delete set null,
       project_id    int references construction_projects(id) on delete set null,
       blueprint_id  int references blueprints(id) on delete set null,
       origin        text not null default 'legacy' check (origin in ('construction', 'placed', 'import', 'legacy')),
       built_day     int,
       description   text,
       active        boolean not null default true,
       created_at    timestamptz not null default now()
     )`,
    `create index if not exists buildings_owner_idx on buildings (owner_type, owner_id)`,

    `create table if not exists property_listings (
       id            serial primary key,
       building_id   int not null references buildings(id) on delete cascade,
       kind          text not null check (kind in ('sale', 'lease')),
       seller_type   text not null check (seller_type in ('user', 'company')),
       seller_id     int not null,
       price_minor   bigint not null check (price_minor >= 0),
       currency_id   int not null references currencies(id),
       term_sessions numeric(8, 2),
       note          text,
       status        text not null default 'active' check (status in ('active', 'sold', 'leased', 'cancelled')),
       created_day   int not null default 0,
       created_by    int references users(id) on delete set null,
       closed_day    int,
       buyer_type    text,
       buyer_id      int
     )`,
    `create unique index if not exists property_listings_one_active on property_listings (building_id) where status = 'active'`,

    `create table if not exists leases (
       id            serial primary key,
       building_id   int not null references buildings(id) on delete cascade,
       listing_id    int references property_listings(id) on delete set null,
       landlord_type text not null, landlord_id int not null,
       tenant_type   text not null check (tenant_type in ('user', 'company')), tenant_id int not null,
       rent_minor    bigint not null check (rent_minor >= 0),
       currency_id   int not null references currencies(id),
       start_day     int not null,
       end_day       int,
       status        text not null default 'active' check (status in ('active', 'ended')),
       ended_day     int,
       end_reason    text,
       unpaid_frac   numeric(20, 6) not null default 0,
       paid_total    bigint not null default 0
     )`,
    `create unique index if not exists leases_one_active on leases (building_id) where status = 'active'`,

    // Register what already exists. Workplaces (with their own store), then storage, then finished plain buildings.
    `do $$ declare w record; s record; p record; pr record; pile int; begin
       for w in select * from workplaces order by id loop
         select cp.* into pr from construction_projects cp
           where cp.status = 'complete' and cp.result_ref->>'workplaceId' = w.id::text order by cp.id limit 1;
         pile := null;
         select st.id into pile from stockpiles st
           where st.id = w.stockpile_id and st.owner_type = w.owner_type and st.owner_id = w.owner_id
             and not exists (select 1 from buildings b where b.stockpile_id = st.id);
         insert into buildings (name, kind, settlement_id, owner_type, owner_id, workplace_id, stockpile_id,
                                project_id, blueprint_id, origin, built_day, active)
         values (w.name, 'workplace', w.settlement_id, w.owner_type, w.owner_id, w.id, pile,
                 pr.id, pr.blueprint_id, case when pr.id is null then 'legacy' else 'construction' end, pr.completed_day, w.active);
       end loop;
       for s in select * from stockpiles st where st.kind <> 'personal' and st.settlement_id is not null
                  and not exists (select 1 from buildings b where b.stockpile_id = st.id) order by st.id loop
         select cp.* into pr from construction_projects cp
           where cp.status = 'complete' and cp.result_type = 'stockpile' and cp.result_ref->>'stockpileId' = s.id::text order by cp.id limit 1;
         insert into buildings (name, kind, settlement_id, owner_type, owner_id, stockpile_id, project_id, blueprint_id, origin, built_day, active)
         values (s.name, 'storage', s.settlement_id, s.owner_type, s.owner_id, s.id, pr.id, pr.blueprint_id,
                 case when pr.id is null then 'legacy' else 'construction' end, pr.completed_day, s.active);
       end loop;
       for p in select * from construction_projects where status = 'complete' and result_type = 'none' order by id loop
         insert into buildings (name, kind, settlement_id, owner_type, owner_id, project_id, blueprint_id, origin, built_day)
         values (p.name, 'building', p.settlement_id, p.owner_type, p.owner_id, p.id, p.blueprint_id, 'construction', p.completed_day);
       end loop;
     end $$`,
  ],
];
