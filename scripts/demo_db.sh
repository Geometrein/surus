#!/usr/bin/env bash
# Create (or reuse) a local Postgres demo database for Surus.
#   container: surus-pg   port: 55432   db: demo   user/pass: postgres/postgres
# Idempotent: re-running reuses the container and reloads the sample schema.
#
# The sample is a deliberately *rich* multi-domain model — e-commerce, HR,
# support, marketing, and analytics — so the IDE/agent can show off everything
# it introspects: five schemas, custom enum types, varied column types (jsonb,
# arrays, uuid, inet, numeric), self-referencing trees/hierarchies, many-to-many
# junction tables, cross-schema foreign keys (a real ERD), views, materialized
# views, several index kinds (unique, partial, composite, GIN/GIST), and two
# extensions Surus has plugins for: TimescaleDB and
# PostGIS (geography columns + a spatial index).
set -euo pipefail

NAME=surus-pg
PORT=55432
# timescaledb-ha bundles TimescaleDB *and* PostGIS, so both plugins light up.
IMAGE=timescale/timescaledb-ha:pg16

# Recreate the container if it's missing or running a different image (e.g. an
# older plain postgres:16 demo) — the bundled extensions need this image.
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  current=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)
  if [ "$current" != "$IMAGE" ]; then
    echo "replacing container $NAME (image '$current' → '$IMAGE') …"
    docker rm -f "$NAME" >/dev/null
  fi
fi

if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "creating container $NAME on :$PORT …"
  docker run -d --name "$NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=demo \
    -p "$PORT":5432 "$IMAGE" >/dev/null
else
  echo "starting existing container $NAME …"
  docker start "$NAME" >/dev/null
fi

# The timescaledb-ha image restarts Postgres once during first boot (to load
# preload libraries), so a single pg_isready can catch the pre-restart window.
# Require several *consecutive* successful real queries against the demo DB — a
# mid-boot restart fails a query and resets the streak.
echo -n "waiting for Postgres "
ok=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" psql -U postgres -d demo -tAc 'SELECT 1' >/dev/null 2>&1; then
    ok=$((ok+1)); [ "$ok" -ge 3 ] && { echo " ready"; break; }
  else
    ok=0
  fi
  echo -n "."; sleep 1
done

echo "loading sample schema (commerce / hr / support / marketing / analytics) …"
docker exec -i "$NAME" psql -U postgres -d demo -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
-- ── reset ──────────────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS commerce  CASCADE;
DROP SCHEMA IF EXISTS hr        CASCADE;
DROP SCHEMA IF EXISTS support   CASCADE;
DROP SCHEMA IF EXISTS marketing CASCADE;
DROP SCHEMA IF EXISTS analytics CASCADE;
-- legacy single-schema demo objects (from older versions of this script)
DROP TABLE IF EXISTS public.orders    CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;

CREATE SCHEMA commerce;
CREATE SCHEMA hr;
CREATE SCHEMA support;
CREATE SCHEMA marketing;
CREATE SCHEMA analytics;

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS timescaledb; -- Surus plugin hides its internal catalog schemas
CREATE EXTENSION IF NOT EXISTS postgis;     -- spatial types (Surus plugin hides system objs)

-- ── enum types ─────────────────────────────────────────────────────────────
CREATE TYPE commerce.order_status   AS ENUM ('pending','paid','packed','shipped','delivered','cancelled','refunded');
CREATE TYPE commerce.payment_method AS ENUM ('card','paypal','bank_transfer','gift_card');
CREATE TYPE hr.employment_type      AS ENUM ('full_time','part_time','contractor','intern');
CREATE TYPE hr.time_off_status      AS ENUM ('pending','approved','denied');
CREATE TYPE support.ticket_status   AS ENUM ('open','pending','resolved','closed');
CREATE TYPE support.ticket_priority AS ENUM ('low','normal','high','urgent');
CREATE TYPE support.author_type     AS ENUM ('customer','employee');
CREATE TYPE marketing.channel       AS ENUM ('email','sms','push');

-- ── hr schema ──────────────────────────────────────────────────────────────
CREATE TABLE hr.departments (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  cost_center text
);

CREATE TABLE hr.employees (
  id            serial PRIMARY KEY,
  department_id int REFERENCES hr.departments(id),
  manager_id    int REFERENCES hr.employees(id),         -- self-reference
  full_name     text NOT NULL,
  email         text NOT NULL UNIQUE,
  type          hr.employment_type NOT NULL DEFAULT 'full_time',
  salary        numeric(10,2),
  hired_on      date NOT NULL DEFAULT current_date,
  is_active     boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_employees_department ON hr.employees(department_id);
CREATE INDEX idx_employees_manager    ON hr.employees(manager_id);

CREATE TABLE hr.time_off_requests (
  id          serial PRIMARY KEY,
  employee_id int NOT NULL REFERENCES hr.employees(id) ON DELETE CASCADE,
  start_date  date NOT NULL,
  end_date    date NOT NULL CHECK (end_date >= start_date),
  status      hr.time_off_status NOT NULL DEFAULT 'pending',
  reason      text
);
CREATE INDEX idx_time_off_employee ON hr.time_off_requests(employee_id);

-- ── commerce schema ────────────────────────────────────────────────────────
CREATE TABLE commerce.categories (
  id        serial PRIMARY KEY,
  parent_id int REFERENCES commerce.categories(id),       -- self-reference (tree)
  name      text NOT NULL,
  slug      text NOT NULL UNIQUE
);

CREATE TABLE commerce.suppliers (
  id      serial PRIMARY KEY,
  name    text NOT NULL,
  country char(2) NOT NULL,
  rating  numeric(2,1) CHECK (rating BETWEEN 0 AND 5)
);

CREATE TABLE commerce.products (
  id           bigserial PRIMARY KEY,
  sku          text NOT NULL UNIQUE,
  category_id  int REFERENCES commerce.categories(id),
  supplier_id  int REFERENCES commerce.suppliers(id),
  name         text NOT NULL,
  price        numeric(10,2) NOT NULL CHECK (price >= 0),
  in_stock     int NOT NULL DEFAULT 0,
  tags         text[] NOT NULL DEFAULT '{}',               -- array
  attributes   jsonb NOT NULL DEFAULT '{}',                -- jsonb
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_category  ON commerce.products(category_id);
CREATE INDEX idx_products_supplier  ON commerce.products(supplier_id);
CREATE INDEX idx_products_attrs_gin ON commerce.products USING gin (attributes);   -- GIN on jsonb
CREATE INDEX idx_products_active    ON commerce.products(category_id) WHERE is_active;  -- partial

CREATE TABLE commerce.warehouses (
  id      serial PRIMARY KEY,
  name    text NOT NULL,
  city    text,
  country char(2)
);

-- many-to-many: stock per product per warehouse
CREATE TABLE commerce.inventory (
  product_id   bigint NOT NULL REFERENCES commerce.products(id) ON DELETE CASCADE,
  warehouse_id int    NOT NULL REFERENCES commerce.warehouses(id) ON DELETE CASCADE,
  quantity     int    NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (product_id, warehouse_id)
);
CREATE INDEX idx_inventory_warehouse ON commerce.inventory(warehouse_id);

CREATE TABLE commerce.coupons (
  id           serial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  discount_pct numeric(4,1) NOT NULL CHECK (discount_pct BETWEEN 0 AND 100),
  valid_from   date NOT NULL,
  valid_to     date
);

CREATE TABLE commerce.customers (
  id          bigserial PRIMARY KEY,
  uuid        uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name        text NOT NULL,
  email       text UNIQUE,
  country     char(2),
  signup_ip   inet,                                        -- network type
  marketing   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_country ON commerce.customers(country);

CREATE TABLE commerce.addresses (
  id          serial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES commerce.customers(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'shipping',
  line1       text NOT NULL,
  city        text,
  postcode    text,
  country     char(2)
);
CREATE INDEX idx_addresses_customer ON commerce.addresses(customer_id);

-- many-to-many: customer wishlist
CREATE TABLE commerce.wishlists (
  customer_id bigint NOT NULL REFERENCES commerce.customers(id) ON DELETE CASCADE,
  product_id  bigint NOT NULL REFERENCES commerce.products(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
CREATE INDEX idx_wishlists_product ON commerce.wishlists(product_id);

CREATE TABLE commerce.orders (
  id            bigserial PRIMARY KEY,
  customer_id   bigint NOT NULL REFERENCES commerce.customers(id),
  employee_id   int REFERENCES hr.employees(id),            -- cross-schema FK (sales rep)
  coupon_id     int REFERENCES commerce.coupons(id),
  status        commerce.order_status NOT NULL DEFAULT 'pending',
  total         numeric(12,2) NOT NULL DEFAULT 0,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  shipped_at    timestamptz
);
CREATE INDEX idx_orders_customer ON commerce.orders(customer_id);
CREATE INDEX idx_orders_status   ON commerce.orders(status, placed_at);   -- composite

-- composite primary key + two FKs (classic join table)
CREATE TABLE commerce.order_items (
  order_id   bigint NOT NULL REFERENCES commerce.orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES commerce.products(id),
  quantity   int NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX idx_order_items_product ON commerce.order_items(product_id);

CREATE TABLE commerce.shipments (
  id           bigserial PRIMARY KEY,
  order_id     bigint NOT NULL UNIQUE REFERENCES commerce.orders(id) ON DELETE CASCADE,
  carrier      text NOT NULL,
  tracking_no  text NOT NULL,
  shipped_at   timestamptz,
  delivered_at timestamptz
);

CREATE TABLE commerce.payments (
  id         bigserial PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES commerce.orders(id) ON DELETE CASCADE,
  method     commerce.payment_method NOT NULL,
  amount     numeric(12,2) NOT NULL,
  paid_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_order ON commerce.payments(order_id);

CREATE TABLE commerce.reviews (
  id         bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES commerce.products(id) ON DELETE CASCADE,
  customer_id bigint REFERENCES commerce.customers(id) ON DELETE SET NULL,
  rating     int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reviews_product ON commerce.reviews(product_id);
CREATE UNIQUE INDEX uq_reviews_customer_product
  ON commerce.reviews(customer_id, product_id) WHERE customer_id IS NOT NULL;  -- partial unique

-- ── PostGIS: physical stores with a geography point + spatial index ─────────
CREATE TABLE commerce.stores (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  city     text,
  location geography(Point,4326) NOT NULL                  -- spatial type
);
CREATE INDEX idx_stores_location ON commerce.stores USING gist (location);   -- GIST spatial

-- ── support schema ────────────────────────────────────────────────────────
CREATE TABLE support.tickets (
  id                   bigserial PRIMARY KEY,
  customer_id          bigint NOT NULL REFERENCES commerce.customers(id) ON DELETE CASCADE,
  assigned_employee_id int    REFERENCES hr.employees(id),   -- cross-schema FK
  subject              text NOT NULL,
  status               support.ticket_status   NOT NULL DEFAULT 'open',
  priority             support.ticket_priority NOT NULL DEFAULT 'normal',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_customer ON support.tickets(customer_id);
CREATE INDEX idx_tickets_status   ON support.tickets(status, priority);   -- composite

CREATE TABLE support.ticket_messages (
  id                  bigserial PRIMARY KEY,
  ticket_id           bigint NOT NULL REFERENCES support.tickets(id) ON DELETE CASCADE,
  author_type         support.author_type NOT NULL,
  author_employee_id  int REFERENCES hr.employees(id),
  body                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ticket_messages_ticket ON support.ticket_messages(ticket_id);

-- ── marketing schema ──────────────────────────────────────────────────────
CREATE TABLE marketing.campaigns (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  channel   marketing.channel NOT NULL,
  starts_on date NOT NULL,
  ends_on   date
);

-- many-to-many: which customers got which campaign, with engagement funnel
CREATE TABLE marketing.campaign_sends (
  campaign_id int    NOT NULL REFERENCES marketing.campaigns(id) ON DELETE CASCADE,
  customer_id bigint NOT NULL REFERENCES commerce.customers(id)  ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL,
  opened_at   timestamptz,
  clicked_at  timestamptz,
  PRIMARY KEY (campaign_id, customer_id)
);
CREATE INDEX idx_campaign_sends_customer ON marketing.campaign_sends(customer_id);

-- ════════════════════════ seed data ════════════════════════════════════════

-- departments + employees (with a manager hierarchy)
INSERT INTO hr.departments (name, cost_center) VALUES
  ('Sales','CC-100'),('Support','CC-200'),('Engineering','CC-300'),
  ('Warehouse','CC-400'),('Marketing','CC-500');

INSERT INTO hr.employees (department_id, manager_id, full_name, email, type, salary)
  SELECT (random()*4+1)::int,
         NULLIF((random()*60)::int, 0),                  -- some report to emp 1..60
         'Employee ' || g,
         'emp' || g || '@surus.example',
         (ARRAY['full_time','full_time','part_time','contractor','intern'])[(random()*4+1)::int]::hr.employment_type,
         round((40000 + random()*90000)::numeric, 2)
  FROM generate_series(1,120) g;

INSERT INTO hr.time_off_requests (employee_id, start_date, end_date, status, reason)
  SELECT (random()*119+1)::int,
         d,
         d + (random()*10)::int,
         (ARRAY['pending','approved','approved','denied'])[(random()*3+1)::int]::hr.time_off_status,
         (ARRAY['Vacation','Sick leave','Personal','Conference'])[(random()*3+1)::int]
  FROM (SELECT current_date - (random()*365)::int AS d FROM generate_series(1,200)) s;

-- category tree: 8 roots, ~40 children
INSERT INTO commerce.categories (parent_id, name, slug)
  SELECT NULL, 'Cat ' || g, 'cat-' || g FROM generate_series(1,8) g;
INSERT INTO commerce.categories (parent_id, name, slug)
  SELECT (random()*7+1)::int, 'Subcat ' || g, 'subcat-' || g FROM generate_series(1,40) g;

INSERT INTO commerce.suppliers (name, country, rating)
  SELECT 'Supplier ' || g,
         (ARRAY['US','DE','CN','GB','FR','JP','IT'])[(random()*6+1)::int],
         round((random()*5)::numeric, 1)
  FROM generate_series(1,30) g;

-- products with array tags + jsonb attributes
INSERT INTO commerce.products (sku, category_id, supplier_id, name, price, in_stock, tags, attributes)
  SELECT 'SKU-' || lpad(g::text, 6, '0'),
         (random()*47+1)::int,
         (random()*29+1)::int,
         'Product ' || g,
         round((5 + random()*495)::numeric, 2),
         (random()*500)::int,
         (ARRAY['new','sale','popular','eco','limited'])[1:(random()*3+1)::int],
         jsonb_build_object(
           'color',  (ARRAY['red','green','blue','black','white'])[(random()*4+1)::int],
           'weight', round((random()*10)::numeric, 2),
           'dims',   jsonb_build_object('w',(random()*50)::int,'h',(random()*50)::int)
         )
  FROM generate_series(1,3000) g;

INSERT INTO commerce.warehouses (name, city, country) VALUES
  ('North DC','Chicago','US'),('South DC','Atlanta','US'),('EU Central','Berlin','DE'),
  ('EU West','Lyon','FR'),('UK Hub','Manchester','GB'),('APAC Hub','Osaka','JP');

-- each product stocked in 1-3 distinct warehouses
INSERT INTO commerce.inventory (product_id, warehouse_id, quantity)
  SELECT p.id, w.warehouse_id, (random()*300)::int
  FROM commerce.products p
  CROSS JOIN LATERAL (
    SELECT DISTINCT (random()*5+1)::int AS warehouse_id
    FROM generate_series(1,(random()*2+1)::int)
  ) w;

INSERT INTO commerce.coupons (code, discount_pct, valid_from, valid_to)
  SELECT 'PROMO' || lpad(g::text, 3, '0'),
         round((5 + random()*45)::numeric, 1),
         current_date - (random()*180)::int,
         current_date + (random()*180)::int
  FROM generate_series(1,25) g;

-- customers
INSERT INTO commerce.customers (name, email, country, signup_ip, marketing)
  SELECT 'Customer ' || g,
         'c' || g || '@example.com',
         (ARRAY['US','DE','GB','FR','CA','AU','NL'])[(random()*6+1)::int],
         ('192.168.' || (random()*255)::int || '.' || (random()*255)::int)::inet,
         random() < 0.4
  FROM generate_series(1,5000) g;

-- one or two addresses each
INSERT INTO commerce.addresses (customer_id, kind, line1, city, postcode, country)
  SELECT c.id,
         (ARRAY['shipping','billing'])[(random()*1+1)::int],
         (random()*9000+1)::int || ' Main St',
         (ARRAY['Berlin','London','Paris','Austin','Toronto'])[(random()*4+1)::int],
         lpad((random()*99999)::int::text, 5, '0'),
         c.country
  FROM commerce.customers c, generate_series(1,2) s
  WHERE random() < 0.7;

-- wishlists: customer <-> product many-to-many
INSERT INTO commerce.wishlists (customer_id, product_id, added_at)
  SELECT (random()*4999+1)::int,
         (random()*2999+1)::int,
         now() - (random()*90)::int * interval '1 day'
  FROM generate_series(1,4000)
ON CONFLICT DO NOTHING;

-- orders (sales rep = an employee, optional coupon)
INSERT INTO commerce.orders (customer_id, employee_id, coupon_id, status, total, placed_at, shipped_at)
  SELECT (random()*4999+1)::int,
         NULLIF((random()*120)::int, 0),
         CASE WHEN random() < 0.2 THEN (random()*24+1)::int END,
         (ARRAY['pending','paid','packed','shipped','delivered','delivered','cancelled','refunded'])[(random()*7+1)::int]::commerce.order_status,
         0,
         now() - (random()*365)::int * interval '1 day',
         CASE WHEN random() < 0.6 THEN now() - (random()*30)::int * interval '1 day' END
  FROM generate_series(1,20000);

-- order_items: 1..5 distinct products per order
INSERT INTO commerce.order_items (order_id, product_id, quantity, unit_price)
  SELECT o.id, p.product_id, (random()*4+1)::int,
         (SELECT price FROM commerce.products WHERE id = p.product_id)
  FROM commerce.orders o
  CROSS JOIN LATERAL (
    SELECT DISTINCT (random()*2999+1)::int AS product_id
    FROM generate_series(1,(random()*4+1)::int)
  ) p;

-- denormalize order totals from items
UPDATE commerce.orders o
SET total = sub.t
FROM (SELECT order_id, sum(quantity*unit_price) AS t FROM commerce.order_items GROUP BY order_id) sub
WHERE o.id = sub.order_id;

-- shipments for orders that have actually shipped
INSERT INTO commerce.shipments (order_id, carrier, tracking_no, shipped_at, delivered_at)
  SELECT id,
         (ARRAY['UPS','FedEx','DHL','USPS'])[(random()*3+1)::int],
         'TRK' || lpad((random()*999999999)::bigint::text, 9, '0'),
         shipped_at,
         CASE WHEN status = 'delivered' THEN shipped_at + (random()*5)::int * interval '1 day' END
  FROM commerce.orders
  WHERE status IN ('shipped','delivered') AND shipped_at IS NOT NULL;

-- payments for non-pending/cancelled orders
INSERT INTO commerce.payments (order_id, method, amount, paid_at)
  SELECT id,
         (ARRAY['card','card','paypal','bank_transfer','gift_card'])[(random()*4+1)::int]::commerce.payment_method,
         total,
         placed_at + interval '1 hour'
  FROM commerce.orders
  WHERE status NOT IN ('pending','cancelled') AND total > 0;

-- product reviews
INSERT INTO commerce.reviews (product_id, customer_id, rating, body)
  SELECT (random()*2999+1)::int,
         (random()*4999+1)::int,
         (random()*4+1)::int,
         (ARRAY['Great!','Okay','Not for me','Excellent value','Would buy again'])[(random()*4+1)::int]
  FROM generate_series(1,10000)
ON CONFLICT DO NOTHING;

-- stores scattered across a few cities (lon/lat → geography point)
INSERT INTO commerce.stores (name, city, location)
  SELECT 'Store ' || g,
         city,
         ST_SetSRID(ST_MakePoint(lon + (random()-0.5), lat + (random()-0.5)), 4326)::geography
  FROM generate_series(1,60) g
  CROSS JOIN LATERAL (
    SELECT * FROM (VALUES
      ('Berlin',  13.40, 52.52),
      ('London',  -0.13, 51.51),
      ('Paris',    2.35, 48.86),
      ('Austin',-97.74, 30.27),
      ('Toronto',-79.38, 43.65)
    ) AS c(city, lon, lat)
    ORDER BY random() LIMIT 1
  ) loc;

-- support tickets, assigned to an employee in the Support dept (id 2)
INSERT INTO support.tickets (customer_id, assigned_employee_id, subject, status, priority, created_at)
  SELECT (random()*4999+1)::int,
         (SELECT id FROM hr.employees WHERE department_id = 2 ORDER BY random() LIMIT 1),
         (ARRAY['Order delayed','Refund request','Product defect','Account question','Shipping address change','Payment issue'])[(random()*5+1)::int],
         (ARRAY['open','pending','resolved','resolved','closed'])[(random()*4+1)::int]::support.ticket_status,
         (ARRAY['low','normal','normal','high','urgent'])[(random()*4+1)::int]::support.ticket_priority,
         now() - (random()*180)::int * interval '1 day'
  FROM generate_series(1,800);

-- 1..6 alternating customer/employee messages per ticket
INSERT INTO support.ticket_messages (ticket_id, author_type, author_employee_id, body, created_at)
  SELECT t.id,
         m.author_type,
         CASE WHEN m.author_type = 'employee' THEN t.assigned_employee_id END,
         CASE WHEN m.author_type = 'customer'
           THEN (ARRAY['My order hasn''t arrived yet.','Can I get a refund?','This item is broken.','How do I change my address?'])[(random()*3+1)::int]
           ELSE (ARRAY['We''re looking into this for you.','Refund has been processed.','A replacement is on the way.','Address updated, thanks!'])[(random()*3+1)::int]
         END,
         t.created_at + (m.i || ' hours')::interval
  FROM support.tickets t
  CROSS JOIN LATERAL (
    SELECT g AS i, (ARRAY['customer','employee'])[((g+1)%2)+1]::support.author_type AS author_type
    FROM generate_series(1,(random()*5+1)::int) g
  ) m;

-- marketing campaigns + per-customer send/open/click funnel
INSERT INTO marketing.campaigns (name, channel, starts_on, ends_on)
  SELECT 'Campaign ' || g,
         (ARRAY['email','email','sms','push'])[(random()*3+1)::int]::marketing.channel,
         current_date - (random()*300)::int,
         current_date - (random()*300)::int + (random()*14)::int
  FROM generate_series(1,15) g;

INSERT INTO marketing.campaign_sends (campaign_id, customer_id, sent_at, opened_at)
  SELECT c.id, cu.id,
         c.starts_on::timestamptz + (random()*5) * interval '1 day',
         CASE WHEN random() < 0.55 THEN c.starts_on::timestamptz + (random()*7) * interval '1 day' END
  FROM marketing.campaigns c
  JOIN commerce.customers cu ON random() < 0.3;

UPDATE marketing.campaign_sends
SET clicked_at = opened_at + (random()*2) * interval '1 hour'
WHERE opened_at IS NOT NULL AND random() < 0.3;

-- ── views ──────────────────────────────────────────────────────────────────
CREATE VIEW commerce.order_summary AS
  SELECT o.id AS order_id, o.status, o.placed_at,
         c.name AS customer, c.country,
         count(oi.product_id) AS line_items,
         o.total
  FROM commerce.orders o
  JOIN commerce.customers c ON c.id = o.customer_id
  LEFT JOIN commerce.order_items oi ON oi.order_id = o.id
  GROUP BY o.id, o.status, o.placed_at, c.name, c.country;

CREATE VIEW marketing.campaign_performance AS
  SELECT c.id AS campaign_id, c.name, c.channel,
         count(*) AS sends,
         count(s.opened_at) AS opens,
         count(s.clicked_at) AS clicks
  FROM marketing.campaigns c
  LEFT JOIN marketing.campaign_sends s ON s.campaign_id = c.id
  GROUP BY c.id, c.name, c.channel;

CREATE MATERIALIZED VIEW analytics.product_sales AS
  SELECT p.id AS product_id, p.name, p.category_id,
         sum(oi.quantity)            AS units_sold,
         sum(oi.quantity*oi.unit_price) AS revenue,
         count(DISTINCT oi.order_id) AS orders
  FROM commerce.products p
  LEFT JOIN commerce.order_items oi ON oi.product_id = p.id
  GROUP BY p.id, p.name, p.category_id
  WITH DATA;
CREATE UNIQUE INDEX uq_product_sales ON analytics.product_sales(product_id);

CREATE MATERIALIZED VIEW analytics.daily_revenue AS
  SELECT date_trunc('day', placed_at)::date AS day,
         count(*) AS orders,
         sum(total) AS revenue
  FROM commerce.orders
  WHERE status NOT IN ('cancelled','refunded')
  GROUP BY 1
  WITH DATA;

ANALYZE;
SQL

echo "done — demo DB ready at postgresql://postgres:postgres@localhost:$PORT/demo"
echo "      schemas: commerce, hr, support, marketing, analytics"
echo "      ~3k products / 5k customers / 20k orders / 800 tickets / 15 campaigns"
echo "      extensions: timescaledb + postgis (commerce.stores)"
