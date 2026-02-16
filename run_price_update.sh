#!/bin/bash
# Run the price update SQL on the Tashkheesa database
cd /Users/ziadelwahsh/Desktop/tashkheesa-portal
echo "=== Before: Service count ==="
sqlite3 data/portal.db "SELECT COUNT(*) as total, SUM(CASE WHEN base_price > 0 THEN 1 ELSE 0 END) as with_price, SUM(CASE WHEN base_price IS NULL OR base_price = 0 THEN 1 ELSE 0 END) as no_price FROM services;"
echo ""
echo "=== Running price updates ==="
