-- Seed data ported from the reference Django app's db.sqlite3 + media/products/.
-- Transactional tables (addresses, orders, order_items, payments) are intentionally
-- skipped: the new app starts with clean order history.

-- categories
INSERT INTO categories (id, name, slug) VALUES
  (1, 'Peripherals', 'peripherals'),
  (2, 'Hubs & Docks', 'hubs-docks'),
  (3, 'Desk Toys', 'desk-toys');

-- products
INSERT INTO products (id, category_id, name, slug, description, price_cents, stock, is_active, created_at, updated_at) VALUES
  (1, 1, 'Mechanical Keyboard', 'mechanical-keyboard', 'Tenkeyless, hot-swappable switches, way too loud for the office.', 12990, 11, 1, 1783620055, 1783620055),
  (2, 2, 'USB-C Dock', 'usb-c-dock', 'Two 4K displays, 100W passthrough, only mildly warm to the touch.', 7900, 1, 1, 1783620055, 1783620055),
  (3, 3, 'Rubber Duck', 'rubber-duck', 'Senior debugging consultant. Does not bill hourly.', 420, 0, 1, 1783620055, 1783620055),
  (4, 1, 'Ergonomic Mouse', 'ergonomic-mouse', 'Vertical grip, six buttons, cures nothing but feels like it might.', 4990, 27, 1, 1783620055, 1783620055),
  (5, 2, 'HDMI Cable 2m', 'hdmi-cable-2m', '8K@60Hz certified. It is a cable. It carries video.', 1230, 41, 1, 1783620055, 1783620055),
  (6, 3, 'Fidget Cube', 'fidget-cube', 'Six sides of productive-looking procrastination.', 990, 15, 1, 1783620055, 1783620055);

-- product_images
INSERT INTO product_images (id, product_id, r2_key, alt_text, sort_order) VALUES
  (1, 1, 'products/mechanical-keyboard.png', 'Mechanical Keyboard', 0),
  (2, 2, 'products/usb-c-dock.png', 'USB-C Dock', 0),
  (3, 3, 'products/rubber-duck.png', 'Rubber Duck', 0),
  (4, 4, 'products/ergonomic-mouse.png', 'Ergonomic Mouse', 0),
  (5, 5, 'products/hdmi-cable-2m.png', 'HDMI Cable 2m', 0),
  (6, 6, 'products/fidget-cube.png', 'Fidget Cube', 0);

-- reviews
INSERT INTO reviews (id, product_id, author_name, rating, text, created_at) VALUES
  (1, 1, 'Tomas', 5, 'Colleagues hate it. I love it. 10/10.', 1783620055),
  (2, 1, 'Petra', 4, 'Great build, but the stock keycaps are meh.', 1783620055),
  (3, 2, 'Marek', 3, 'Works, but gets warmer than "mildly" if you ask me.', 1783620055),
  (4, 3, 'Jana', 5, 'Solved a race condition just by listening. Incredible.', 1783620055),
  (5, 3, 'David', 5, 'Best senior engineer on the team.', 1783620055),
  (6, 3, 'Filip', 4, 'Squeaks slightly off-key.', 1783620055),
  (7, 4, 'Lucie', 4, 'Took a week to get used to, now I cannot go back.', 1783620055);

-- coupons
INSERT INTO coupons (id, code, discount_type, value_hundredths, is_active, valid_from, valid_to) VALUES
  (1, 'WELCOME10', 'percent', 1000, 1, NULL, NULL),
  (2, 'FLAT5', 'fixed', 500, 1, NULL, NULL),
  (3, 'EXPIRED10', 'percent', 1000, 1, 1778436055, 1781028055);

-- users (fresh pbkdf2_sha256 hashes computed for the demo passwords via Node's
-- crypto.pbkdf2Sync, 100000 iterations / 16-byte salt / 32-byte derived key,
-- matching the exact string format worker/src/lib/hash.ts's verifyPassword parses)
INSERT INTO users (id, email, password_hash, first_name, last_name, is_staff, is_active, is_superuser, date_joined) VALUES
  (1, 'admin@example.com', 'pbkdf2_sha256$100000$iDLL6H1hNd63W9vrZRWM8g==$Kt5mMbOstlnEQivG37IU6xtZw3NAx9fr54dQJGawvlo=', '', '', 1, 1, 1, 1784046444),
  (2, 'student@example.com', 'pbkdf2_sha256$100000$8h6RwX4wRa1+8koER0m6Zw==$NXTVGCls/eLQPslskLLB2045LHQkXHWP/zWRb02/c4A=', 'Test', 'Student', 0, 1, 0, 1784046444);
